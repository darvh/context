import type { Node } from "../core/parse";
import type { Ctx } from "./core";
import { addSym, childField, refEdge, walk, classifyFile, promoteKinds, addCallEdges } from "./core";

// Generic tree-sitter extractor for languages without a bespoke walker
// (java, ruby, rust, c, cpp, c#, php, bash). One walker covers the shared
// declaration/call/import node shapes; node type names verified against the
// bundled grammars from grammars/ (see scripts/build/embed-grammars.ts). rg remains the fallback for parse
// failures and languages with no usable wasm (swift, kotlin, scala, ...).

const FUNCTION_NODES = new Set([
  "function_definition", // c, cpp, php, bash
  "method_declaration", // java, cs
  "function_item", // rust
  "method", // ruby
  "constructor_declaration", // java
  "singleton_method", // ruby
]);

const CLASS_NODES = new Set([
  "class_declaration", // java, cs, php
  "class_specifier", // cpp
  "struct_declaration", // cs
  "interface_declaration", // java, cs
  "enum_declaration", // java, cs, php
  "record_declaration", // java, cs
  "trait_declaration", // php
  "class", // ruby
  "module", // ruby
  "struct_item", // rust
  "enum_item", // rust
  "trait_item", // rust
  "type_item", // rust
  "union_item", // rust
  "struct_specifier", // c, cpp
  "union_specifier", // c, cpp
  "enum_specifier", // c, cpp
]);

const CONST_NODES = new Set([
  "field_declaration", // java, cs members
  "const_item", // rust
  "static_item", // rust
  "preproc_def", // c/cpp #define
]);

const CALL_NODES = new Set([
  "call_expression", // c, cpp, rust
  "method_invocation", // java
  "invocation_expression", // cs
  "function_call_expression", // php
  "method_call", // ruby
  "call", // ruby
]);

const IMPORT_NODES = new Set([
  "import_declaration", // java
  "using_directive", // cs
  "preproc_include", // c/cpp
  "use_declaration", // rust
  "namespace_use_declaration", // php
]);

function nameOf(n: Node): string {
  // ruby's `class`/`method` nodes reuse the `name` field for the body; the
  // real name is the first named child
  if (n.type === "class" || n.type === "module" || n.type === "method" || n.type === "singleton_method") {
    const first = n.namedChild(0);
    return first ? first.text : n.text.slice(0, 60);
  }
  const f = childField(n, "name");
  if (f) return f.text;
  // c/cpp: function_definition wraps the declarator as a `function_declarator`
  // child (field `type`), which itself carries the identifier
  const fd = n.namedChildren.find((c) => c && c.type === "function_declarator");
  if (fd) {
    const dd = childField(fd, "declarator");
    return dd ? dd.text : fd.text;
  }
  const first = n.namedChild(0);
  return first ? first.text : n.text.slice(0, 60);
}

function kindForType(t: string): "class" | "struct" | "interface" | "type" {
  if (t.startsWith("interface") || t.startsWith("trait") || t.startsWith("module")) return "interface";
  if (t.startsWith("struct") || t.startsWith("union")) return "struct";
  if (t.startsWith("enum") || t === "type_item") return "type";
  return "class";
}

function addImport(ctx: Ctx, n: Node) {
  const nameNode = childField(n, "name") ?? childField(n, "path") ?? childField(n, "argument") ?? n.namedChild(0);
  if (!nameNode) return;
  const module = nameNode.text.replace(/["'<>]/g, "");
  const local = module.split(/[./]/).pop() || module;
  const imp = addSym(ctx, n, "import", "exact", { name: local, sig: `import ${module}` });
  ctx.imports.push({ file: ctx.file, module, local, at: `${ctx.file}:${n.startPosition.row + 1}` });
  ctx.edges.push({ from: imp.id, to: "", name: local, kind: "import", conf: "exact", at: `${ctx.file}:${n.startPosition.row + 1}` });
}

function collectCalls(ctx: Ctx, root: Node, fromId: string) {
  for (const n of walk(root)) {
    if (!CALL_NODES.has(n.type)) continue;
    const f = childField(n, "function") ?? childField(n, "method") ?? childField(n, "name");
    let target = "";
    let qualifier = "";
    if (f) {
      const parts = f.namedChildren.filter((c) =>
        !!c && ["identifier", "property_identifier", "field_identifier", "type_identifier"].includes(c.type),
      );
      if (parts.length > 1) {
        qualifier = parts.slice(0, -1).map((p) => p!.text).join(".");
        target = parts[parts.length - 1]!.text;
      } else {
        target = f.text;
      }
    } else {
      target = n.namedChild(0)?.text ?? n.text;
    }
    if (!target) continue;
    addCallEdges(ctx, fromId, n, target, qualifier, !!qualifier);
  }
}

function collectFunction(ctx: Ctx, n: Node, fileIsTest: boolean) {
  const name = nameOf(n);
  const kind = n.type === "method" || n.type === "singleton_method" || n.type === "method_declaration" ? "method" : "function";
  const s = addSym(ctx, n, kind, "exact", { name, exported: /^[A-Z]/.test(name), test: fileIsTest });
  if (ctx.lang !== "sh") collectCalls(ctx, n, s.id);
}

export function extractGeneric(root: Node, ctx: Ctx) {
  const { isTest: fileIsTest, isEntry, isConfig } = classifyFile(ctx.file, ctx.lang);

  for (const n of walk(root)) {
    if (FUNCTION_NODES.has(n.type)) {
      collectFunction(ctx, n, fileIsTest);
    } else if (CLASS_NODES.has(n.type)) {
      addSym(ctx, n, kindForType(n.type), "exact", { name: nameOf(n), exported: true, test: fileIsTest });
    } else if (CONST_NODES.has(n.type)) {
      const name = childField(n, "name") ?? n.namedChild(0);
      if (name && name.type !== "comment") {
        addSym(ctx, n, n.type === "preproc_def" ? "const" : "var", "exact", { name: name.text, exported: /^[A-Z]/.test(name.text), test: fileIsTest });
      }
    } else if (IMPORT_NODES.has(n.type)) {
      addImport(ctx, n);
    }
  }

  promoteKinds(ctx, { isEntry, isConfig });
}
