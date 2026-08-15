import type { Node } from "../parse";
import {
  makeId,
  type Confidence,
  type EdgeKind,
  type Kind,
  type SymbolFact,
} from "../facts";
import { DOC_CLEAN_RE, DOC_LINE_RE, ENTRY_SYMBOL_RULES, FILE_PATTERNS, ROUTE_RULES, SIG_LANG_SPECIAL, SIG_STOPS } from "./rules";

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

type Edge = import("../facts").Edge;
type Import = import("../facts").Import;

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
export { childField };

/** iterative depth-first traversal, named children only */
export function walk(n: Node): Node[] {
  const out: Node[] = [];
  const stack = [n];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    for (let i = c.namedChildCount - 1; i >= 0; i--) stack.push(c.namedChild(i)!);
  }
  return out;
}

function declName(n: Node): string {
  const f = childField(n, "name");
  if (f) return f.text;
  const first = n.namedChild(0);
  return first ? first.text : n.text.slice(0, 60);
}

/** signature = source text up to first `{` (or `=>` / `->`) trimmed to one line.
 * Python headers end with `:` so take the whole first line. */
function signatureOf(n: Node, source: string, lang = "go"): string {
  const text = n.text;
  if (SIG_LANG_SPECIAL[lang] === "first-line-only") {
    return text.split("\n")[0].trim();
  }
  for (const stop of SIG_STOPS) {
    const i = text.indexOf(stop);
    if (i >= 0) return text.slice(0, i).replace(/\s+/g, " ").trim();
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function docAbove(ctx: Ctx, n: Node): string {
  const start = n.startPosition.row;
  const out: string[] = [];
  for (let i = start - 1; i >= 0 && i >= start - 5; i--) {
    const t = ctx.lines[i].trim();
    if (DOC_LINE_RE.test(t)) {
      out.unshift(t.replace(DOC_CLEAN_RE, ""));
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
  opts: { exported?: boolean; test?: boolean; sig?: string; name?: string } = {},
): SymbolFact {
  const name = opts.name ?? declName(n);
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

// ---- config-driven helpers (previously hardcoded per extractor) ----

export function classifyFile(file: string, lang: string): { isTest: boolean; isEntry: boolean; isConfig: boolean } {
  const rules = FILE_PATTERNS[lang] ?? FILE_PATTERNS.rg;
  const isTest = rules.test.test(file) || (rules.testAlt ? rules.testAlt.test(file) : false);
  const isEntry = rules.entry.test(file);
  const isConfig = rules.config.test(file);
  return { isTest, isEntry, isConfig };
}

function getRouteRule(lang: string) {
  return ROUTE_RULES[lang] ?? null;
}
export function isRouteCall(lang: string, method: string, base: string): boolean {
  const r = getRouteRule(lang);
  return !!r && r.methods.has(method) && r.bases.has(base);
}

export function promoteKinds(ctx: Ctx, flags: { isEntry: boolean; isConfig: boolean }) {
  const rules = ENTRY_SYMBOL_RULES[ctx.lang] ?? ENTRY_SYMBOL_RULES.rg;
  for (const s of ctx.symbols) {
    if (flags.isEntry && s.kind === "function" && rules.func?.test(s.name)) s.kind = "entry";
    if (flags.isEntry && s.kind === "class" && rules.class?.test(s.name)) s.kind = "entry";
    if (flags.isConfig && rules.configKinds.has(s.kind)) s.kind = "config";
  }
}

/** shared call-edge helper: member call => heuristic for property + resolved for qualifier */
export function addCallEdges(ctx: Ctx, fromId: string, n: Node, target: string, qualifier: string, isMember: boolean) {
  if (!target) return;
  if (isMember) {
    refEdge(ctx, fromId, n, target, "call", "heuristic");
    if (qualifier) refEdge(ctx, fromId, n, qualifier, "call", "resolved");
  } else {
    refEdge(ctx, fromId, n, target, "call", "resolved");
  }
}

export function addRouteSymbol(ctx: Ctx, node: Node, object: string, property: string, path: string, toId = "") {
  const s = addSym(ctx, node, "route", "heuristic", {
    exported: false,
    sig: `${object}.${property}(${path})`,
  });
  s.name = path;
  ctx.edges.push({ from: s.id, to: toId, name: path, kind: toId ? "call" : "ref", conf: "heuristic", at: `${ctx.file}:${node.startPosition.row + 1}` });
  return s;
}

export type Extractor = (root: Node, ctx: Ctx) => void;
