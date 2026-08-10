import type { Node } from "../parse";
import {
  makeId,
  type Confidence,
  type Edge,
  type EdgeKind,
  type FileFacts,
  type Import,
  type Kind,
  type Span,
  type SymbolFact,
} from "../facts";

export interface Ctx {
  file: string;
  lang: string;
  hash: string;
  source: string;
  lines: string[];
  symbols: SymbolFact[];
  edges: Edge[];
  imports: Import[];
  byName: Map<string, string[]>; // name -> symbol ids in this file
}

const pos = (n: Node) => ({
  sl: n.startPosition.row + 1,
  sc: n.startPosition.column + 1,
  el: n.endPosition.row + 1,
  ec: n.endPosition.column + 1,
});

function childField(n: Node, field: string): Node | null {
  for (let i = 0; i < n.childCount; i++) {
    const f = n.fieldNameForChild(i);
    if (f === field) return n.child(i);
  }
  return null;
}

export function declName(n: Node): string {
  const f = childField(n, "name");
  if (f) return f.text;
  const first = n.namedChild(0);
  return first ? first.text : n.text.slice(0, 60);
}

/** signature = source text up to first `{` (or `=>` / `->`) trimmed to one line.
 * Python headers end with `:` so take the whole first line. */
export function signatureOf(n: Node, source: string, lang = "go"): string {
  const text = n.text;
  if (lang === "py") {
    return text.split("\n")[0].trim();
  }
  for (const stop of ["{", "=>", "->", ":=", ":"]) {
    const i = text.indexOf(stop);
    if (i >= 0) return text.slice(0, i).replace(/\s+/g, " ").trim();
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function docAbove(ctx: Ctx, n: Node): string {
  const start = n.startPosition.row;
  const out: string[] = [];
  for (let i = start - 1; i >= 0 && i >= start - 5; i--) {
    const t = ctx.lines[i].trim();
    if (/^(\/\/|\/\*|\*|#|"""|'''|--)/.test(t)) {
      out.unshift(t.replace(/^(\/\/|\*|#|"""?|'''?)\s*/, ""));
    } else break;
  }
  return out.join(" ").slice(0, 200);
}

export function newCtx(file: string, lang: string, hash: string, source: string): Ctx {
  return {
    file,
    lang,
    hash,
    source,
    lines: source.split("\n"),
    symbols: [],
    edges: [],
    imports: [],
    byName: new Map(),
  };
}

export function addSym(
  ctx: Ctx,
  n: Node,
  kind: Kind,
  conf: Confidence,
  opts: { exported?: boolean; test?: boolean; sig?: string } = {},
): SymbolFact {
  const name = declName(n);
  const s: SymbolFact = {
    id: makeId(ctx.file, name, n.startPosition.row + 1),
    file: ctx.file,
    kind,
    name,
    sig: opts.sig ?? signatureOf(n, ctx.source, ctx.lang),
    span: pos(n),
    nameLine: n.startPosition.row + 1,
    exported: !!opts.exported,
    test: !!opts.test,
    doc: docAbove(ctx, n),
    conf,
  };
  ctx.symbols.push(s);
  ctx.byName.set(name, [...(ctx.byName.get(name) ?? []), s.id]);
  return s;
}

/** record a reference (call/name use); caller resolves to a target id or leaves to="" (heuristic). */
export function refEdge(ctx: Ctx, fromId: string, n: Node, name: string, kind: EdgeKind, conf: Confidence) {
  ctx.edges.push({ from: fromId, to: "", name, kind, conf, at: `${ctx.file}:${n.startPosition.row + 1}` });
  return ctx.edges[ctx.edges.length - 1];
}

export interface ExtractResult {
  ctx: Ctx;
  dispose: () => void;
}

export type Extractor = (root: Node, ctx: Ctx) => void;
