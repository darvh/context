import type { Node } from "../core/parse";
import type { Ctx } from "./core";
import { addSym, childField, refEdge, walk, classifyFile, promoteKinds, addCallEdges, isRouteCall } from "./core";
import { TEST_IDENTS } from "./rules";


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
    addCallEdges(ctx, fromId, n, t.name, t.qualifier, t.isMember);
  }
}

export function extractPy(root: Node, ctx: Ctx) {
  const { isTest: fileIsTest, isEntry, isConfig } = classifyFile(ctx.file, ctx.lang);

  const handleDecorators = (defNode: Node, targetId: string): Node | undefined => {
    for (const dec of defNode.namedChildren.filter((c) => c.type === "decorator")) {
      const inner = dec.namedChild(0);
      if (inner && inner.type === "attribute") {
        const attr = inner.namedChild(inner.namedChildCount - 1);
        const obj = inner.namedChild(0);
        if (attr && obj && isRouteCall("py", attr.text, obj.text)) {
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

  // decorators wrap their target: a decorated function/class is a
  // `decorated_definition` node containing the real definition. Without
  // unwrapping, every @decorated symbol (flask's @setupmethod, routes) is
  // silently dropped from the graph.
  const unwrapDef = (n: Node): Node => {
    if (n.type !== "decorated_definition") return n;
    return n.namedChildren.find((c) => c.type === "function_definition" || c.type === "class_definition") ?? n;
  };

  const handleDef = (outer: Node, n: Node, kind: "function" | "class") => {
    const nm = nameField(n);
    const name = nm ? nm.text : "anon";
    const isTest = fileIsTest || (kind === "function" && name.startsWith(TEST_IDENTS.py.funcPrefix)) || (kind === "class" && name.startsWith(TEST_IDENTS.py.classPrefix));
    const s = addSym(ctx, n, kind, "exact", {
      exported: name[0] !== "_",
      test: isTest,
    });
    if (kind === "function") {
      collectCalls(ctx, n, s.id);
    } else {
      const sup = n.namedChildren.filter((c) => c.type === "identifier" || c.type === "attribute");
      for (const b of sup) {
        ctx.edges.push({ from: s.id, to: "", name: b.text.split(".").pop()!, kind: "inherit", conf: "resolved", at: `${ctx.file}:${b.startPosition.row + 1}` });
      }
      // methods are DIRECT children of the class body — nested functions of
      // methods belong to the method, not the class (and must not be added
      // twice: once here, once by the main loop)
      const body = n.namedChildren.find((c) => c.type === "block");
      for (const c of body?.namedChildren ?? []) {
        const cm = unwrapDef(c);
        if (cm.type !== "function_definition") continue;
        const mnm = nameField(cm);
        const mname = mnm ? mnm.text : "m";
        const m = addSym(ctx, cm, "method", "exact", { test: mname.startsWith(TEST_IDENTS.py.funcPrefix) });
        collectCalls(ctx, cm, m.id);
        ctx.edges.push({ from: s.id, to: m.id, name: mname, kind: "contain", conf: "exact", at: `${ctx.file}:${cm.startPosition.row + 1}` });
      }
    }
    handleDecorators(outer, s.id);
    if (isTest) collectTestUses(ctx, n, s.id);
  };

  const inClass = (n: Node): boolean => {
    for (let p = n.parent; p; p = p.parent) if (p.type === "class_definition") return true;
    return false;
  };

  for (const n of walk(root)) {
    const inner = unwrapDef(n);
    switch (n.type) {
      case "decorated_definition":
        if (inClass(inner)) break;
        handleDef(n, inner, inner.type === "class_definition" ? "class" : "function");
        break;
      case "function_definition":
        if (inClass(n)) break;
        handleDef(n, n, "function");
        break;
      case "class_definition":
        handleDef(n, n, "class");
        break;
      case "import_statement":
      case "import_from_statement": {
        const module = n.type === "import_from_statement"
          ? (n.namedChild(0)?.text ?? "")
          : (n.namedChildren.find((c) => c.type === "dotted_name")?.text ?? "");
        const imp = addSym(ctx, n, "import", "exact", { sig: `import ${module || n.text.slice(0, 50)}` });
        imp.name = module.split(".").pop() || module;
        const bindings: string[] = [];
        for (const c of n.namedChildren) {
          if (!c) continue;
          if (n.type === "import_from_statement" && c === n.namedChild(0)) continue;
          if (c.type === "aliased_import") bindings.push(c.namedChild(0)?.text ?? "");
          else if (c.type === "identifier") bindings.push(c.text);
          else if (c.type === "dotted_name") bindings.push(c.text.split(".").pop() ?? "");
        }
        if (!bindings.length) bindings.push(imp.name);
        for (const b of bindings) {
          ctx.imports.push({ file: ctx.file, module, local: b, at: `${ctx.file}:${n.startPosition.row + 1}` });
          ctx.edges.push({ from: imp.id, to: "", name: b, kind: "import", conf: "exact", at: `${ctx.file}:${n.startPosition.row + 1}` });
        }
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

  promoteKinds(ctx, { isEntry, isConfig });
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
