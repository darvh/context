import type { Node } from "../parse";
import type { Ctx } from "./core";
import { addSym, childField, refEdge, walk } from "./core";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "route"]);
const ROUTE_BASES = new Set(["app", "bp", "blueprint", "router"]);

function isTestFile(f: string) {
  return /(^|\/)test_.*\.py$|(^|\/)tests?\//.test(f);
}

function nameField(n: Node): Node | null {
  return childField(n, "name");
}

function callTarget(n: Node): { name: string; qualifier: string; isMember: boolean } {
  const fn = n.namedChild(0);
  if (!fn) return { name: "", qualifier: "", isMember: false };
  if (fn.type === "identifier") return { name: fn.text, qualifier: "", isMember: false };
  if (fn.type === "attribute") {
    const obj = fn.namedChild(0);
    const attr = fn.namedChild(fn.namedChildCount - 1);
    return { name: attr ? attr.text : "", qualifier: obj ? obj.text : "", isMember: true };
  }
  return { name: fn.text, qualifier: "", isMember: false };
}

function collectCalls(ctx: Ctx, root: Node, fromId: string) {
  for (const n of walk(root)) {
    if (n.type !== "call") continue;
    const t = callTarget(n);
    if (!t.name) continue;
    if (t.isMember) {
      refEdge(ctx, fromId, n, t.name, "call", "heuristic");
      if (t.qualifier) refEdge(ctx, fromId, n, t.qualifier, "call", "resolved");
    } else {
      refEdge(ctx, fromId, n, t.name, "call", "resolved");
    }
  }
}

export function extractPy(root: Node, ctx: Ctx) {
  const fileIsTest = isTestFile(ctx.file);
  const isEntryFile = /(^|\/)(main|__main__|cli)\.py$/.test(ctx.file) || /(^|\/)cmd\//.test(ctx.file);
  const isConfigFile = /config|settings|env/i.test(ctx.file);

  const handleDecorators = (defNode: Node, targetId: string): Node | undefined => {
    for (const dec of defNode.namedChildren.filter((c) => c.type === "decorator")) {
      const inner = dec.namedChild(0);
      if (inner && inner.type === "attribute") {
        const attr = inner.namedChild(inner.namedChildCount - 1);
        const obj = inner.namedChild(0);
        if (attr && ROUTE_METHODS.has(attr.text) && obj && ROUTE_BASES.has(obj.text)) {
          const arg = dec.namedChildren.find((c) => c.type === "string");
          const routePath = arg ? arg.text.replace(/['"]/g, "") : attr.text.toUpperCase();
          const s = addSym(ctx, dec, "route", "heuristic", { sig: `${obj.text}.${attr.text}(${routePath})` });
          s.name = routePath;
          ctx.edges.push({ from: s.id, to: targetId, name: routePath, kind: "call", conf: "resolved", at: `${ctx.file}:${dec.startPosition.row + 1}` });
          return dec;
        }
      }
    }
    return undefined;
  };

  const handleDef = (n: Node, kind: "function" | "class") => {
    const nm = nameField(n);
    const name = nm ? nm.text : "anon";
    const isTest = fileIsTest || (kind === "function" && name.startsWith("test_")) || (kind === "class" && name.startsWith("Test"));
    const s = addSym(ctx, n, kind, "exact", {
      exported: name[0] !== "_",
      test: isTest,
    });
    if (kind === "function") {
      collectCalls(ctx, n, s.id);
    } else {
      // base classes
      const sup = n.namedChildren.filter((c) => c.type === "identifier" || c.type === "attribute");
      for (const b of sup) {
        ctx.edges.push({ from: s.id, to: "", name: b.text.split(".").pop()!, kind: "inherit", conf: "resolved", at: `${ctx.file}:${b.startPosition.row + 1}` });
      }
      for (const c of walk(n)) {
        if (c.type === "function_definition" && c.parent !== n) {
          const mnm = nameField(c);
          const mname = mnm ? mnm.text : "m";
          const m = addSym(ctx, c, "method", "exact", { test: mname.startsWith("test_") });
          collectCalls(ctx, c, m.id);
          ctx.edges.push({ from: s.id, to: m.id, name: mname, kind: "contain", conf: "exact", at: `${ctx.file}:${c.startPosition.row + 1}` });
        }
      }
    }
    handleDecorators(n, s.id);
    if (isTest) collectTestUses(ctx, n, s.id);
  };

  for (const n of walk(root)) {
    switch (n.type) {
      case "function_definition":
        if (n.parent && n.parent.type === "class_definition") break; // handled by class pass
        handleDef(n, "function");
        break;
      case "class_definition":
        handleDef(n, "class");
        break;
      case "import_statement":
      case "import_from_statement": {
        const module = n.type === "import_from_statement"
          ? (n.namedChild(0)?.text ?? "")
          : (n.namedChildren.find((c) => c.type === "dotted_name")?.text ?? "");
        const aliases = n.namedChildren.filter((c) => c.type === "aliased_import").map((c) => c.namedChild(0)?.text ?? "");
        const imp = addSym(ctx, n, "import", "exact", { sig: `import ${module || n.text.slice(0, 50)}` });
        imp.name = module.split(".").pop() || module;
        ctx.imports.push({ file: ctx.file, module, local: module.split(".").pop() || "", at: `${ctx.file}:${n.startPosition.row + 1}` });
        for (const a of aliases) ctx.edges.push({ from: imp.id, to: "", name: a, kind: "import", conf: "exact", at: `${ctx.file}:${n.startPosition.row + 1}` });
        break;
      }
      case "assignment": {
        const left = n.namedChild(0);
        if (left && left.type === "identifier" && n.parent?.type === "module") {
          const s = addSym(ctx, n, /^[A-Z_]+$/.test(left.text) ? "const" : "var", "exact", {});
          s.name = left.text;
          void s;
        }
        break;
      }
    }
  }

  for (const s of ctx.symbols) {
    if (isEntryFile && s.kind === "function" && /^(main|cli)$/.test(s.name)) s.kind = "entry";
    if (isConfigFile && (s.kind === "const" || s.kind === "var")) s.kind = "config";
  }
}

function collectTestUses(ctx: Ctx, root: Node, fromId: string) {
  const seen = new Set<string>();
  for (const n of walk(root)) {
    if (n.type === "identifier") {
      const t = n.text;
      if (!seen.has(t) && /^[a-z][a-zA-Z0-9_]*$/.test(t) && !ctx.byName.has(t) && !["self", "assert", "None", "True", "False", "if", "else", "return"].includes(t)) {
        seen.add(t);
        refEdge(ctx, fromId, n, t, "test", "resolved");
      }
    }
  }
}
