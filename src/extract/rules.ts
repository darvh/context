// data-driven config maps — single source of truth for patterns previously hardcoded per extractor

export const FILE_PATTERNS: Record<string, { test: RegExp; testAlt?: RegExp; entry: RegExp; config: RegExp }> = {
  ts: {
    test: /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    entry: /(^|\/)(index|main|cli|server)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    config: /(^|\/)(config|settings|env)\.|\.config\./,
  },
  js: {
    test: /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    entry: /(^|\/)(index|main|cli|server)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    config: /(^|\/)(config|settings|env)\.|\.config\./,
  },
  py: {
    test: /(^|\/)test_.*\.py$|(^|\/)tests?\//,
    entry: /(^|\/)(main|__main__|cli)\.py$|(^|\/)cmd\//,
    config: /config|settings|env/i,
  },
  go: {
    test: /_test\.go$/,
    entry: /(^|\/)(main\.go|cmd\/)/,
    config: /config|settings|env/i,
  },
  rg: {
    test: /(^|\/)(test|tests|spec|__tests__|_test)(\/|\.|_)/i,
    testAlt: /\.(test|spec)_/i,
    entry: /(^|\/)(main|cli|__main__|app|index)\./,
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

export const TEST_IDENTS = {
  ts: new Set(["it", "test", "describe", "beforeEach", "afterEach", "beforeAll", "afterAll"]),
  go: /^(Test|Benchmark|Example|Fuzz)[A-Z]/,
  py: { funcPrefix: "test_", classPrefix: "Test" },
};

export const ENTRY_SYMBOL_RULES: Record<string, { func?: RegExp; class?: RegExp; configKinds: Set<string> }> = {
  ts: { func: /^(main|cli|server|start)$/, class: /^App$|Server/, configKinds: new Set(["const", "type"]) },
  js: { func: /^(main|cli|server|start)$/, class: /^App$|Server/, configKinds: new Set(["const", "type"]) },
  py: { func: /^(main|cli)$/, configKinds: new Set(["const", "var"]) },
  go: { func: /^main$/, configKinds: new Set(["const"]) },
  rg: { func: /^(main|cli|app|index)$/, configKinds: new Set(["const", "var"]) },
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
  fn: /^(?:(?:export|pub|default|async|private|public|protected|static|extern|internal|open|abstract|final|sealed)\s+)*(?:async\s+)?(?:fn|function|def|func)\s+([A-Za-z_$][\w$]*)/,
  class: /^(?:(?:export|pub|public|private|abstract|final|internal|open|sealed|static)\s+)*(?:class|struct|trait|interface|enum)\s+([A-Za-z_][\w$]*)/,
  type: /^(?:(?:export|pub|public|type)\s+)*type\s+([A-Za-z_][\w$]*)\s*[=:{]/,
  const: /^(?:(?:export|pub|public|final|static|const)\s+)*(?:const|let|var|val|defconst)\s+([A-Za-z_$][\w$]*)\s*=/,
};

export type RgKind = "function" | "class" | "interface" | "struct" | "type" | "const" | "var";

export const RG_DECL_KINDS: Array<{ re: RegExp; kind: (line: string) => RgKind }> = [
  { re: RG_DECL.fn, kind: () => "function" },
  { re: RG_DECL.class, kind: (line) => (/\b(struct|enum)\b/.test(line) ? "struct" : /\b(class|trait|interface)\b/.test(line) ? "class" : "class") },
  { re: RG_DECL.type, kind: () => "type" },
  { re: RG_DECL.const, kind: (line) => (/^\s*(const|final|val)\b/.test(line) ? "const" : "var") },
];

// unified import regexes previously in rg.ts
export const RG_IMPORT_RES = [
  /^\s*import\s+(?:from\s+)?["']([^"']+)["']/,
  /^\s*from\s+([\w.]+)\s+import\b/,
  /^\s*import\s+([\w.]+)\s*;?$/,
  /^\s*(?:use|using|require)\s+([\w.$:/]+)/,
] as const;

// generic fallback for quick kind inference from line
export function rgKindFromLine(line: string): RgKind {
  if (/^\s*(async\s+)?(fn|function|def|func)\b/.test(line)) return "function";
  if (/\b(class|trait|interface)\b/.test(line)) return "class";
  if (/\b(struct|enum)\b/.test(line)) return "struct";
  if (/^\s*type\b/.test(line)) return "type";
  if (/^\s*(const|final|val)\b/.test(line)) return "const";
  return "var";
}
