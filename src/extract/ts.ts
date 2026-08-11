import type { Node } from "../parse";
import type { Ctx } from "./core";
import { addSym, childField, refEdge, walk, classifyFile, promoteKinds, addCallEdges, addRouteSymbol, isRouteCall } from "./core";
import { TEST_IDENTS } from "./rules";

function isExported(n: Node): boolean {
  let cur: Node | null = n;
  while (cur) {
    if (cur.type === "export_statement" || cur.type.startsWith("export")) return true;
    if (cur.type === "source_file" || cur.type === "program") return false;
    cur = cur.parent;
  }
  return false;
}

function nameNode(n: Node): Node | null {
  return childField(n, "name");
}

interface MemberUse {
  object: string;
  property: string;
}

function memberOf(n: Node): MemberUse | undefined {
  if (n.type === "member_expression" || n.type === "optional_chain") {
    const obj = n.namedChild(0);
    const prop = n.namedChild(n.namedChildCount - 1);
    return { object: obj ? obj.text : "", property: prop ? prop.text : "" };
  }
  return undefined;
}

function collectCallsIn(ctx: Ctx, root: Node, fromId: string) {
  for (const c of walk(root)) {
    if (c.type === "call_expression") collectCalls(ctx, c, fromId, c);
  }
}

function collectCalls(ctx: Ctx, root: Node, fromId: string, node: Node) {
  if (node.type !== "call_expression") return;
  const fn = node.namedChild(0);
  if (!fn) return;
  if (fn.type === "identifier") {
    refEdge(ctx, fromId, node, fn.text, "call", "resolved");
  } else {
    const m = memberOf(fn);
    if (m) {
      addCallEdges(ctx, fromId, node, m.property, m.object, true);
      if (isRouteCall("ts", m.property, m.object)) {
        const firstArg = node.namedChild(1);
        const routePath = firstArg && (firstArg.type === "string" || firstArg.type === "template_string")
          ? firstArg.text.replace(/['"`]/g, "")
          : m.property.toUpperCase();
        addRouteSymbol(ctx, node, m.object, m.property, routePath);
      }
    }
  }
}

function collectInherit(ctx: Ctx, classNode: Node, classId: string) {
  const text = classNode.text;
  const ext = /extends\s+([A-Za-z_$][\w.$]*)/.exec(text);
  const impl = /implements\s+([A-Za-z_$][\w.$]*(?:\s*,\s*[A-Za-z_$][\w.$]*)*)/.exec(text);
  if (ext) ctx.edges.push({ from: classId, to: "", name: ext[1].split(".").pop()!, kind: "inherit", conf: "resolved", at: `${ctx.file}:${classNode.startPosition.row + 1}` });
  if (impl) for (const t of impl[1].split(",")) ctx.edges.push({ from: classId, to: "", name: t.trim().split(".").pop()!, kind: "implement", conf: "resolved", at: `${ctx.file}:${classNode.startPosition.row + 1}` });
}

function collectTestDecl(ctx: Ctx, node: Node, fromId: string) {
  const fn = node.namedChild(0)?.text ?? "";
  const args = node.namedChild(1);
  const firstArg = args?.namedChild(0);
  const name = firstArg && firstArg.type === "string"
    ? firstArg.text.replace(/['"`]/g, "")
    : fn;
  const s = addSym(ctx, node, "test", "exact", { test: true, sig: `${fn}(${name})` });
  s.name = name;
  for (const c of walk(node)) {
    if (c.type === "call_expression") collectCalls(ctx, c, s.id, c);
  }
  void fromId;
}

export function extractTsJs(root: Node, ctx: Ctx) {
  const { isTest: fileIsTest, isEntry: isEntryFile, isConfig: isConfigFile } = classifyFile(ctx.file, ctx.lang);

  for (const n of walk(root)) {
    switch (n.type) {
      case "import_statement": {
        let module = "";
        const src = n.namedChildren.find((c) => c.type === "string");
        if (src) module = src.text.replace(/['"]/g, "");
        const locals: string[] = [];
        for (const c of n.namedChildren) {
          if (c.type === "import_clause") {
            for (const name of walk(c)) {
              if (name.type === "identifier" && name.parent && (name.parent.type === "import_specifier" || name.parent.type === "namespace_import" || name.parent.type === "import_clause")) {
                locals.push(name.text);
              }
            }
          }
        }
        const imp = addSym(ctx, n, "import", "exact", { sig: `import ${module || n.text.slice(0, 60)}` });
        imp.name = module.split("/").pop() || module || "import";
        ctx.imports.push({ file: ctx.file, module, local: module.split("/").pop() || "", at: `${ctx.file}:${n.startPosition.row + 1}` });
        for (const l of locals) ctx.edges.push({ from: imp.id, to: "", name: l, kind: "import", conf: "exact", at: `${ctx.file}:${n.startPosition.row + 1}` });
        break;
      }
      case "function_declaration":
      case "generator_function_declaration": {
        const s = addSym(ctx, n, "function", "exact", { exported: isExported(n), test: fileIsTest });
        collectCallsIn(ctx, n, s.id);
        break;
      }
      case "class_declaration": {
        const s = addSym(ctx, n, "class", "exact", { exported: isExported(n), test: fileIsTest });
        collectInherit(ctx, n, s.id);
        break;
      }
      case "method_definition": {
        const s = addSym(ctx, n, "method", "exact", { exported: isExported(n), test: fileIsTest });
        collectCallsIn(ctx, n, s.id);
        break;
      }
      case "interface_declaration":
      case "type_alias_declaration": {
        const s = addSym(ctx, n, n.type === "interface_declaration" ? "interface" : "type", "exact", { exported: isExported(n), test: fileIsTest });
        if (n.type === "interface_declaration") collectInherit(ctx, n, s.id);
        break;
      }
      case "variable_declarator": {
        const nm = nameNode(n);
        if (!nm || nm.type !== "identifier") break;
        const value = n.namedChild(n.namedChildCount - 1);
        const isFn = value && (value.type === "function_expression" || value.type === "arrow_function");
        const s = addSym(ctx, n, isFn ? "function" : "const", "exact", { exported: isExported(n), test: fileIsTest });
        if (isFn) collectCallsIn(ctx, n, s.id);
        break;
      }
      case "call_expression": {
        if (n.namedChild(0)?.type === "identifier") {
          const fname = n.namedChild(0)!.text;
          if (TEST_IDENTS.ts.has(fname) && fileIsTest) {
            collectTestDecl(ctx, n, "");
          }
        }
        break;
      }
    }
  }

  promoteKinds(ctx, { isEntry: isEntryFile, isConfig: isConfigFile });
}
