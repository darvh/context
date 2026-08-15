export type Confidence = "exact" | "resolved" | "heuristic";

export type Kind =
  | "function"
  | "class"
  | "method"
  | "struct"
  | "interface"
  | "type"
  | "const"
  | "var"
  | "import"
  | "route"
  | "test"
  | "config"
  | "entry"
  | "doc"
  | "file";

export interface Span {
  sl: number; // start line, 1-based
  sc: number; // start col, 1-based
  el: number; // end line, 1-based
  ec: number; // end col, 1-based
}

export interface SymbolFact {
  id: string;
  file: string;
  kind: Kind;
  name: string;
  sig: string;
  span: Span;
  nameLine: number;
  exported: boolean;
  test: boolean;
  doc: string;
  conf: Confidence;
  /** bounded runtime strings from the symbol body (literals), for lexical
   *  matching of error/config/log strings the name/sig/doc cannot see */
  strings?: string[];
}

export type EdgeKind = "call" | "import" | "inherit" | "implement" | "ref" | "contain" | "test";

export interface Edge {
  from: string; // symbol id
  to: string; // symbol id, or "" for unresolved external ref
  name: string; // referenced name (informational)
  kind: EdgeKind;
  conf: Confidence;
  at: string; // "file:line"
}

export interface Import {
  file: string;
  module: string;
  local: string;
  at: string;
}

export interface FileFacts {
  file: string;
  lang: string;
  hash: string;
  symbols: SymbolFact[];
  edges: Edge[];
  imports: Import[];
}

export interface Graph {
  symbols: SymbolFact[];
  edges: Edge[];
  imports: Import[];
}

export function makeId(file: string, name: string, line: number): string {
  return `${file}::${name}::${line}`;
}
