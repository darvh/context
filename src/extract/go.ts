import type { Node } from "../parse";
import type { Ctx } from "./core";
import { addSym, childField, refEdge, walk } from "./core";

const isTestFile = (f: string) => /_test\.go$/.test(f);

function collectTypeSymbols(ctx: Ctx, typeDecl: Node, fileIsTest: boolean) {
  for (let i = 0; i < typeDecl.namedChildCount; i++) {
    const spec = typeDecl.namedChild(i);
    if (!spec || spec.type !== "type_spec") continue;
    const nameNode = childField(spec, "name");
    if (!nameNode) continue;
    const name = nameNode.text;
    const value = spec.namedChildren.find((c) => c.type.endsWith("_type")) ?? spec.namedChildren[spec.namedChildCount - 1];
    let kind: "struct" | "interface" | "type" = "type";
    if (value) {
      if (value.type === "struct_type") kind = "struct";
      else if (value.type === "interface_type") kind = "interface";
    }
    const s = addSym(ctx, spec, kind, "exact", {
      exported: /^[A-Z]/.test(name),
      test: fileIsTest,
    });
    // nested field methods
    if (value && (value.type === "struct_type" || value.type === "interface_type")) {
      const body = value.namedChildren.find((c) => c.type === "field_declaration_list" || c.type === "type_body");
      if (body) {
        for (const fd of body.namedChildren) {
          if (fd.type === "method_elem") {
            const mname = fd.namedChild(0)?.text;
            if (mname) {
              const m = addSym(ctx, fd, "method", "exact", {
                exported: /^[A-Z]/.test(mname),
                test: fileIsTest,
              });
              ctx.edges.push({ from: s.id, to: m.id, name: mname, kind: "contain", conf: "exact", at: `${ctx.file}:${fd.startPosition.row + 1}` });
            }
          }
        }
      }
    }
    if (kind === "interface") {
      for (const elem of value.namedChildren) {
        if (elem.type === "type_identifier") {
          ctx.edges.push({ from: s.id, to: "", name: elem.text, kind: "inherit", conf: "heuristic", at: `${ctx.file}:${elem.startPosition.row + 1}` });
        }
      }
    }
  }
}

function collectFunction(ctx: Ctx, fn: Node, fileIsTest: boolean) {
  const nameNode = childField(fn, "name");
  const name = nameNode ? nameNode.text : fn.text.slice(0, 40);
  const isMethod = fn.type === "method_declaration";
  const kind: "function" | "method" = isMethod ? "method" : "function";
  const isTest = fileIsTest || /^(Test|Benchmark|Example|Fuzz)[A-Z]/.test(name);
  const s = addSym(ctx, fn, kind, "exact", {
    exported: /^[A-Z]/.test(name),
    test: isTest,
  });
  collectCalls(ctx, fn, s.id);
  // interface implementation: receiver field of method carries type name
  if (isMethod) {
    const recv = childField(fn, "receiver");
    if (recv) {
      const tid = recv.namedChildren.find((c) => c.type === "type_identifier");
      if (tid) {
        ctx.edges.push({ from: s.id, to: "", name: tid.text, kind: "implement", conf: "resolved", at: `${ctx.file}:${tid.startPosition.row + 1}` });
      }
    }
  }
  if (isTest) {
    // references to production symbols inside test body
    collectNameUses(ctx, fn, s.id, "test", "resolved");
  }
}

function collectCalls(ctx: Ctx, root: Node, fromId: string) {
  for (const n of walk(root)) {
    if (n.type !== "call_expression") continue;
    const fn = childField(n, "function");
    if (!fn) continue;
    if (fn.type === "identifier") {
      refEdge(ctx, fromId, n, fn.text, "call", "resolved");
    } else if (fn.type === "selector_expression") {
      const sel = fn.namedChildren.filter((c) => c.type === "identifier" || c.type === "field_identifier");
      const qual = sel[0]?.text ?? "";
      const mem = sel[1]?.text ?? "";
      refEdge(ctx, fromId, n, mem || fn.text, "call", "heuristic");
      if (qual) refEdge(ctx, fromId, n, qual, "call", "resolved");
    }
  }
}

function collectNameUses(ctx: Ctx, root: Node, fromId: string, kind: "ref" | "test", conf: "exact" | "resolved") {
  const seen = new Set<string>();
  for (const n of walk(root)) {
    if (n.type === "identifier" && n.startPosition.row > root.startPosition.row + 0) {
      const t = n.text;
      if (/^[A-Z][a-zA-Z0-9]*$/.test(t) && !seen.has(t) && !ctx.byName.has(t)) {
        seen.add(t);
        refEdge(ctx, fromId, n, t, kind, conf);
      }
    }
  }
}

export function extractGo(root: Node, ctx: Ctx) {
  const fileIsTest = isTestFile(ctx.file);
  const isEntryFile = /(^|\/)(main\.go|cmd\/)/.test(ctx.file);
  const isConfigFile = /config|settings|env/i.test(ctx.file);

  for (const n of walk(root)) {
    switch (n.type) {
      case "import_declaration": {
        const specs = n.namedChildren.flatMap((c) =>
          c.type === "import_spec_list" ? c.namedChildren.filter((s) => s.type === "import_spec") : c.type === "import_spec" ? [c] : [],
        );
        for (const spec of specs) {
          let local = "";
          const alias = spec.namedChild(0);
          if (alias && alias.type === "package_identifier") local = alias.text;
          const str = spec.namedChildren.find((c) => c.type === "interpreted_string_literal");
          const module = str ? str.text.replace(/["`]/g, "") : spec.text;
          const name = local || module.split("/").pop() || module;
          const imp = addSym(ctx, spec, "import", "exact", { sig: `import ${module}` });
          ctx.imports.push({ file: ctx.file, module, local: local || name, at: `${ctx.file}:${spec.startPosition.row + 1}` });
          ctx.edges.push({ from: imp.id, to: "", name: name, kind: "import", conf: "exact", at: `${ctx.file}:${spec.startPosition.row + 1}` });
        }
        break;
      }
      case "function_declaration":
      case "method_declaration":
        collectFunction(ctx, n, fileIsTest);
        break;
      case "type_declaration":
        collectTypeSymbols(ctx, n, fileIsTest);
        break;
      case "const_declaration":
      case "var_declaration": {
        for (const spec of n.namedChildren) {
          if (spec.type !== "const_spec" && spec.type !== "var_spec") continue;
          for (const id of spec.namedChildren.filter((c) => c.type === "identifier")) {
            addSym(ctx, spec, n.type === "const_declaration" ? "const" : "var", "exact", {
              exported: /^[A-Z]/.test(id.text),
              test: fileIsTest,
            });
          }
        }
        break;
      }
    }
  }

  for (const s of ctx.symbols) {
    if (isEntryFile && s.kind === "function" && s.name === "main") s.kind = "entry";
    if (isConfigFile && s.kind === "const") s.kind = "config";
  }
}