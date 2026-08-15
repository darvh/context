// data-driven config maps — single source of truth for patterns previously hardcoded per extractor
// Adding a language = add entries here, no code change in extractors (ponytail ladder rung 2)
export const FILE_PATTERNS: Record<string, { entry: RegExp; config: RegExp }> = {
  ts: {
    entry: /(^|\/)(index|main|cli|server)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    config: /(^|\/)(config|settings|env)\.|\.config\./,
  },
  js: {
    entry: /(^|\/)(index|main|cli|server)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    config: /(^|\/)(config|settings|env)\.|\.config\./,
  },
  py: {
    entry: /(^|\/)(main|__main__|cli)\.py$|(^|\/)cmd\//,
    config: /config|settings|env/i,
  },
  go: {
    entry: /(^|\/)(main\.go|cmd\/)/,
    config: /config|settings|env/i,
  },
  // rg fallback generic
  rg: {
    entry: /(^|\/)(main|cli|__main__|app|index)\./,
    config: /config|settings|env/i,
  },
  // --- extra langs: all driven by same rg extractor, just different file heuristics ---
  java: {
    entry: /(^|\/)(Main|Application|App)\.java$/,
    config: /config|settings|env/i,
  },
  rb: {
    entry: /(^|\/)(main|app|application|cli)\.rb$/,
    config: /config|settings|env/i,
  },
  rs: {
    entry: /(^|\/)(main|lib)\.rs$/,
    config: /config|settings|env/i,
  },
  php: {
    entry: /(^|\/)(index|main|app)\.php$/,
    config: /config|settings|env/i,
  },
  c: {
    entry: /(^|\/)(main|app)\.c$/,
    config: /config|settings|env/i,
  },
  cpp: {
    entry: /(^|\/)(main|app)\.(cpp|cc)$/,
    config: /config|settings|env/i,
  },
  cs: {
    entry: /(^|\/)(Program|Main|App)\.cs$/,
    config: /config|settings|env/i,
  },
  kt: {
    entry: /(^|\/)(Main|App|Application)\.kt$/,
    config: /config|settings|env/i,
  },
  swift: {
    entry: /(^|\/)(main|App|Application)\.swift$/,
    config: /config|settings|env/i,
  },
  sh: {
    entry: /(^|\/)(main|cli|app)\.sh$/,
    config: /config|settings|env/i,
  },
  lua: {
    entry: /(^|\/)(main|init)\.lua$/,
    config: /config|settings|env/i,
  },
  scala: {
    entry: /(^|\/)(Main|App)\.scala$/,
    config: /config|settings|env/i,
  },
  dart: {
    entry: /(^|\/)(main|app)\.dart$/,
    config: /config|settings|env/i,
  },
};
export const ROUTE_RULES: Record<string, { methods: Set<string>; bases: Set<string> }> = {
  ts: {
    methods: new Set(["get", "post", "put", "patch", "delete", "options", "use", "route", "all"]),
    bases: new Set(["app", "router", "server", "fastify", "route", "handler", "r"]),
  },
  py: {
    methods: new Set(["get", "post", "put", "patch", "delete", "options", "route"]),
    bases: new Set(["app", "bp", "blueprint", "router"]),
  },
};
// lang-kind test rules (shared ts ident set lives in core/rules.ts TEST_IDENTS)
export const TEST_IDENTS = {
  go: /^(Test|Benchmark|Example|Fuzz)[A-Z]/,
  py: { funcPrefix: "test_", classPrefix: "Test" },
};
export const ENTRY_SYMBOL_RULES: Record<string, { func?: RegExp; class?: RegExp; configKinds: Set<string> }> = {
  ts: { func: /^(main|cli|server|start)$/, class: /^App$|Server/, configKinds: new Set(["const", "type"]) },
  js: { func: /^(main|cli|server|start)$/, class: /^App$|Server/, configKinds: new Set(["const", "type"]) },
  py: { func: /^(main|cli)$/, configKinds: new Set(["const", "var"]) },
  go: { func: /^main$/, configKinds: new Set(["const"]) },
  rg: { func: /^(main|cli|app|index)$/, configKinds: new Set(["const", "var"]) },
  java: { func: /^main$/, class: /^(Main|Application|App)$/, configKinds: new Set(["const", "var"]) },
  rb: { func: /^(main|cli)$/, configKinds: new Set(["const", "var"]) },
  rs: { func: /^main$/, configKinds: new Set(["const"]) },
  php: { func: /^main$/, configKinds: new Set(["const", "var"]) },
  c: { func: /^main$/, configKinds: new Set(["const"]) },
  cpp: { func: /^main$/, configKinds: new Set(["const"]) },
  cs: { func: /^Main$/, class: /^(Program|App)$/, configKinds: new Set(["const"]) },
  kt: { func: /^main$/, class: /^(Main|App|Application)$/, configKinds: new Set(["const", "var"]) },
  swift: { func: /^main$/, configKinds: new Set(["const", "var"]) },
  sh: { func: /^main$/, configKinds: new Set(["const", "var"]) },
  scala: { func: /^main$/, class: /^(Main|App)$/, configKinds: new Set(["const", "var"]) },
  dart: { func: /^main$/, configKinds: new Set(["const", "var"]) },
  lua: { func: /^main$/, configKinds: new Set(["const", "var"]) },
};
// doc comment detection — previously inline regex in core.ts
export const DOC_LINE_RE = /^(\/\/|\/\*|\*|#|"""|'''|--)/;
export const DOC_CLEAN_RE = /^(\/\/|\*|#|"""?|'''?)\s*/;
// signature extraction
export const SIG_STOPS = ["{", "=>", "->", ":=", ":"] as const;
export const SIG_LANG_SPECIAL: Record<string, "first-line-only"> = {
  py: "first-line-only",
};
export const RG_DECL = {
  fn: /^(?:(?:export|pub|default|async|private|public|protected|static|extern|internal|open|abstract|final|sealed)\s+)*(?:async\s+)?(?:fn|function|def|func|sub)\s+([A-Za-z_$][\w$]*)/,
  class: /^(?:(?:export|pub|public|private|abstract|final|internal|open|sealed|static)\s+)*(?:class|struct|trait|interface|enum|object|defmodule)\s+([A-Za-z_][\w$]*)/,
  type: /^(?:(?:export|pub|public|type)\s+)*type\s+([A-Za-z_][\w$]*)\s*[=:{]/,
  const: /^(?:(?:export|pub|public|final|static|const)\s+)*(?:const|let|var|val|defconst)\s+([A-Za-z_$][\w$]*)\s*=/,
  cFunc: /^\s*(?:(?:public|private|protected|static|final|inline|virtual|override|export|async|extern)\s+)*(?:[\w<>:\[\]]+\s+)+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:\{|;|$)/,
  shFunc: /^\s*([A-Za-z_]\w*)\s*\(\)\s*\{/,
  phpClass: /(?:class|interface|trait)\s+([A-Za-z_]\w*)/,
};
export type RgKind = "function" | "class" | "interface" | "struct" | "type" | "const" | "var";
// unified import regexes previously in rg.ts
export const RG_IMPORT_RES = [
  /^\s*import\s+(?:from\s+)?["']([^"']+)["']/,
  /^\s*from\s+([\w.]+)\s+import\b/,
  /^\s*import\s+([\w.]+)\s*;?$/,
  /^\s*(?:use|using|require)\s+([\w.$:/]+)/,
  /^\s*#include\s+[<"]([^>"]+)[>"]/,
] as const;
// generic fallback for quick kind inference from line
export function rgKindFromLine(line: string): RgKind {
  if (/^\s*(async\s+)?(fn|function|def|func|sub)\b/.test(line)) return "function";
  if (/\b(class|trait|interface|object|defmodule)\b/.test(line)) return "class";
  if (/\b(struct|enum)\b/.test(line)) return "struct";
  if (/^\s*type\b/.test(line)) return "type";
  if (/^\s*(const|final|val)\b/.test(line)) return "const";
  // C-style: returnType name(args) {  or  name(args)  — treat as function, not var
  if (/^\s*(?:[\w<>:\[\]]+\s+)+[A-Za-z_]\w*\s*\([^)]*\)\s*(?:\{|;|$)/.test(line)) return "function";
  if (/^\s*[A-Za-z_]\w*\s*\([^)]*\)\s*\{/.test(line)) return "function"; // sh style main() { }
  return "var";
}
