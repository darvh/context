import type { Graph, SymbolFact, Edge } from "./facts";
import type { DocFact } from "./doc";
import type { Bm25Index } from "./bm25";
import { bm25Search } from "./bm25";

/** Split a string into searchable terms: camelCase, snake_case, paths, punctuation. */
export function terms(s: string): string[] {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  // path tokens
  for (const frag of lower.split(/[\\/\s,]+/)) {
    if (!frag) continue;
    if (frag.includes(".") || frag.includes("_") || frag.includes("-")) {
      out.add(frag);
    }
  }
  // word tokens
  for (const m of lower.matchAll(/[a-z0-9]+/g)) out.add(m[0]);
  // camel/snake splits — match on the ORIGINAL casing so [A-Z] boundaries
  // survive (lowercasing first kills every boundary)
  for (const part of s.split(/[^a-zA-Z0-9]+/)) {
    if (!part) continue;
    for (const w of part.matchAll(/[a-z][a-z0-9]*|([A-Z][a-z0-9]*)/g)) out.add(w[0].toLowerCase());
    out.add(part.toLowerCase());
  }
  out.delete("");
  return [...out];
}

// common words carry no retrieval signal; matching code on them drowns real
// matches in hub files (natural-language doc queries especially)
export const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "for", "with", "at", "from", "by", "as", "into", "onto",
  "how", "what", "when", "where", "why", "which", "who", "whom", "whose", "do", "does", "did", "we", "they",
  "you", "your", "i", "me", "my", "he", "she", "him", "her", "his", "their", "them", "us", "our", "itself",
  "will", "would", "can", "could", "should", "have", "has", "had", "not", "but", "so", "if", "then", "than",
  "too", "very", "just", "also", "all", "any", "some", "each", "every", "one", "two", "other", "another",
  "there", "here", "whereas", "whilst", "upon", "within", "without",
]);

export function meaningfulTerms(s: string): string[] {
  return terms(s).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

export interface RankedHit {
  symbol: SymbolFact;
  score: number;
  reason: string[];
  conf: "exact" | "resolved" | "heuristic";
}

export interface QueryInput {
  task: string;
  graph: Graph;
  changed: Set<string>;
  explicitFiles: string[]; // file paths mentioned in task
  /** optional sparse lexical index; when present, BM25 is fused via RRF */
  bm25?: Bm25Index;
  /** non-code doc records (extracted text) surfaced alongside code hits */
  docs?: DocFact[];
}

/** Transient symbol for a doc file — never stored in the graph, only for capsule rendering. */
export function docSymbol(d: DocFact): SymbolFact {
  const name = d.file.split("/").pop() ?? d.file;
  return {
    id: `doc::${d.file}`,
    file: d.file,
    kind: "doc",
    name,
    sig: "",
    span: { sl: 1, sc: 1, el: 1, ec: 1 },
    nameLine: 1,
    exported: false,
    test: false,
    doc: d.text.slice(0, 200),
    conf: "heuristic",
  };
}

export interface SemanticResult {
  id: string; // symbol id, or `doc::<file>` for a doc hit
  sim: number;
}

// a base (graph+lexical) hit at or above this score is a genuine lexical
// match (several distinct query terms in one symbol). Below it, the query is
// low-confidence and semantic results lead — UNLESS an authoritative low-score
// signal (recent-change, explicit-file) already pinned the answer.
const WEAK_BASE_SCORE = 5;
const AUTHORITATIVE_REASONS = ["explicit-file", "recent-change"];

/**
 * Append semantic hits. When the graph/lexical pass is weak (no authoritative
 * signal, few/no term matches — exactly the unresolved/low-confidence queries
 * embeddings are for), semantic hits rank first, ordered by similarity. When
 * lexical has a genuine match or an authoritative signal, semantic appends
 * below it (graph stays authoritative).
 */
export function appendSemanticHits(hits: RankedHit[], sem: SemanticResult[], graph: Graph, docs: DocFact[]): RankedHit[] {
  const seen = new Set(hits.map((h) => h.symbol.id));
  const byId = new Map(graph.symbols.map((s) => [s.id, s]));
  const docById = new Map(docs.map((d) => [d.file, d]));
  let out = [...hits];
  const maxBase = hits[0]?.score ?? 0;
  const authoritative = hits.some((h) => h.reason.some((r) => AUTHORITATIVE_REASONS.includes(r)));
  const weak = hits.length === 0 || (maxBase < WEAK_BASE_SCORE && !authoritative);
  // weak base: a hit the graph already found but semantics agree with keeps
  // its sim position instead of sinking below newer semantic noise (seen
  // hits are deduped out of the append loop, so without this the correct
  // base hit loses to semantically-weaker docs)
  if (weak && hits.length > 0) {
    const simById = new Map(sem.map((s) => [s.id, s.sim]));
    out = hits.map((h) => {
      const sim = simById.get(h.symbol.id);
      if (sim === undefined) return h;
      return { ...h, score: maxBase + sim, reason: [...h.reason, "semantic"] };
    });
  }
  for (const h of sem) {
    let sym: SymbolFact | null = null;
    if (h.id.startsWith("doc::")) {
      const d = docById.get(h.id.slice(5));
      if (d) sym = docSymbol(d);
    } else {
      sym = byId.get(h.id) ?? null;
    }
    if (!sym || seen.has(sym.id)) continue;
    // weak base: semantic leads at maxBase+sim; strong base: append below
    out.push({ symbol: sym, score: weak ? maxBase + h.sim : 0, reason: ["semantic"], conf: sym.conf });
    seen.add(sym.id);
  }
  out.sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.nameLine - b.symbol.nameLine);
  return out;
}

/** Extract repo-relative file paths the task text names directly. */
export function explicitFilesFromTask(task: string, files: string[]): string[] {
  const out = new Set<string>();
  const lower = task.toLowerCase();
  for (const f of files) {
    const base = f.split("/").pop()!;
    // full-path mentions are unambiguous; basenames need a word boundary and
    // an extension so a bare word ("context") doesn't match every context.*
    if (lower.includes(f)) out.add(f);
    else if (/\./.test(base) && new RegExp(`\\b${escapeRegExp(base)}\\b`).test(lower)) out.add(f);
  }
  for (const tok of task.split(/\s+/)) {
    const t = tok.replace(/[`"'()]/g, "").replace(/:.*$/, "");
    if (/[/.]/.test(t) && !t.startsWith("--")) {
      for (const f of files) {
        if (f.endsWith(t) || f === t) out.add(f);
      }
    }
  }
  return [...out];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ScoreState {
  score: number;
  reason: string[];
}

// token sets are stable per graph/docs instance: memoize so N queries over one
// build tokenize each symbol/doc exactly once instead of per query
const symTermsMemo = new WeakMap<Graph, Map<string, Set<string>>>();
const docTermsMemo = new WeakMap<DocFact, Set<string>>();

function symTermsFor(s: SymbolFact, graph: Graph): Set<string> {
  let m = symTermsMemo.get(graph);
  if (!m) {
    m = new Map();
    symTermsMemo.set(graph, m);
  }
  let t = m.get(s.id);
  if (!t) {
    t = new Set([...terms(s.name), ...terms(s.sig), ...terms(s.doc)]);
    m.set(s.id, t);
  }
  return t;
}

function docTermsFor(d: DocFact): Set<string> {
  let t = docTermsMemo.get(d);
  if (!t) {
    t = new Set(meaningfulTerms(d.text));
    docTermsMemo.set(d, t);
  }
  return t;
}

const WEIGHT: Record<Edge["kind"], number> = {
  call: 0.8,
  import: 0.5,
  inherit: 0.7,
  implement: 0.7,
  ref: 0.3,
  contain: 0.6,
  test: 0.5,
};

// generic test framework scaffolding: evidence, not targets
const GENERIC_TEST = new Set(["it", "test", "describe", "expect", "beforeeach", "aftereach", "beforeall", "afterall"]);

export function rankSymbols({ task, graph, changed, explicitFiles, bm25, docs }: QueryInput): RankedHit[] {
  const t = meaningfulTerms(task);
  const tset = new Set(t);
  const byId = new Map(graph.symbols.map((s) => [s.id, s]));
  const inbound = new Map<string, Edge[]>();
  const outbound = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    if (e.from) {
      outbound.set(e.from, [...(outbound.get(e.from) ?? []), e]);
      if (e.to) inbound.set(e.to, [...(inbound.get(e.to) ?? []), e]);
    }
  }

  const state = new Map<string, ScoreState>();
  const ensure = (id: string): ScoreState => {
    let st = state.get(id);
    if (!st) {
      st = { score: 0, reason: [] };
      state.set(id, st);
    }
    return st;
  };

  // strongest code-side identifier match across all symbols (for doc fusion)
  let maxCodeMatched = 0;

  const addReason = (id: string, r: string) => {
    const st = ensure(id);
    if (!st.reason.includes(r)) st.reason.push(r);
  };

  const symTerms = (s: SymbolFact) => symTermsFor(s, graph);

  for (const s of graph.symbols) {
    if (s.kind === "import") continue; // imports are evidence edges, not ranking targets
    const st = ensure(s.id);
    const terms_ = symTerms(s);
    let matched = 0;
    for (const term of t) if (terms_.has(term)) matched++;
    if (matched > maxCodeMatched) maxCodeMatched = matched;
    if (matched > 0) {
      st.score += matched * 2;
      addReason(s.id, "identifier-match");
    }
    // exact full-name match outranks symbols that merely contain the term
    if (s.name.toLowerCase() === task.trim().toLowerCase()) {
      st.score += 4;
      addReason(s.id, "exact-name");
    }
    // path match
    const fileTerms = new Set(terms(s.file));
    let pathMatched = 0;
    for (const term of t) if (fileTerms.has(term)) pathMatched++;
    if (pathMatched > 0) {
      st.score += pathMatched * 1.5;
      addReason(s.id, "path-match");
    }
    // explicit file reference
    const explicit = explicitFiles.includes(s.file);
    if (explicit) {
      st.score += 3;
      addReason(s.id, "explicit-file");
    }
    // recent changes are their own signal
    if (changed.has(s.file)) {
      st.score += 1.2;
      addReason(s.id, "recent-change");
    }
    // kind/hub bonuses only when some lexical or change signal exists,
    // so unrelated queries stay empty instead of surfacing noise
    const relevant = matched > 0 || pathMatched > 0 || explicit || changed.has(s.file);
    if (!relevant) continue;
    if (s.test) { st.score += 0.6; addReason(s.id, "test-match"); }
    if (s.kind === "route" || s.kind === "config" || s.kind === "entry") { st.score += 0.8; addReason(s.id, "entry-or-config"); }
    if (s.exported) st.score += 0.2;
    // hubs: referenced by many (bounded — a helper called by 400 tests must
    // not outrank a direct match)
    const hub = (inbound.get(s.id)?.length ?? 0) + (outbound.get(s.id)?.length ?? 0);
    st.score += Math.min(hub, 30) * 0.04;
    // dampen generic test scaffolding and anonymous short vars as own targets
    if (s.test && GENERIC_TEST.has(s.name)) st.score *= 0.2;
    else if (s.name.length <= 2 && (s.kind === "const" || s.kind === "var" || s.kind === "test")) st.score *= 0.5;
    if (matched === 0 && s.name.length <= 4 && (s.kind === "const" || s.kind === "var" || s.test)) st.score *= 0.4;
  }

  // propagate relevance through edges, 2 hops; cap each symbol's added
  // relation score so hubs of scaffolding don't outrank lexical matches
  const baseScore = new Map<string, number>();
  for (const [id, st] of state) baseScore.set(id, st.score);
  const seeds = [...state.entries()].map(([id, st]) => [id, st.score] as const);
  for (const [id, base] of seeds) {
    if (base <= 0) continue;
    const hop1 = (outbound.get(id) ?? []).filter((e) => e.to);
    for (const e of hop1) {
      const w = WEIGHT[e.kind];
      if (!w) continue;
      const st2 = ensure(e.to);
      const added = base * w * 0.5;
      if (added > st2.score * 0.1) addReason(e.to, `relation-to-${byId.get(id)?.name ?? id}`);
      st2.score += added;
      const hop2 = (outbound.get(e.to) ?? []).filter((e2) => e2.to && e2.to !== e.from);
      for (const e2 of hop2) {
        const w2 = WEIGHT[e2.kind] ?? 0.3;
        // spread thin across the intermediate's fan-out: a hub's 2-hop
        // influence decays with its degree instead of piling on targets
        ensure(e2.to).score += (base * w * w2 * 0.15) / Math.max(1, hop2.length);
      }
    }
  }
  for (const [id, st] of state) {
    const base = baseScore.get(id) ?? 0;
    const cap = base * 2 + 0.4;
    if (st.score > cap) st.score = cap;
  }

  const out: RankedHit[] = [];
  for (const s of graph.symbols) {
    const st = state.get(s.id);
    if (!st || st.score <= 0) continue;
    const conf = s.conf;
    out.push({ symbol: s, score: st.score, reason: st.reason.slice(0, 4), conf });
  }
  out.sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.nameLine - b.symbol.nameLine);

  // Hybrid: BM25 is a fallback signal, not a re-ranker. The graph+lexical
  // score stays authoritative; BM25's porter stemming only APPENDS symbols (or
  // docs) the term matcher missed (paraphrases), ranked below every
  // graph-matched hit. This guarantees hybrid >= baseline and deterministic.
  if (bm25 && graph.symbols.length) {
    const hits = bm25Search(bm25, task);
    if (hits.length) {
      const seen = new Set(out.map((h) => h.symbol.id));
      // Docs score by their REAL BM25 hit (idf + length normalized), but only
      // when the doc covers MORE query terms than the best code symbol (a doc
      // query surfaces its doc) and no authoritative signal pins the answer
      // (exact-name / recent-change / explicit-file). Otherwise docs append at
      // 0 — the graph lane stays authoritative. A gated doc is floored at its
      // own coverage in graph-score space (2/term) so BM25's different
      // magnitude can't lose to a weak code match.
      const pinned = out.some((h) => h.reason.some((r) => AUTHORITATIVE_REASONS.includes(r) || r === "exact-name"));
      const maxGraph = out[0]?.score ?? 0;
      const docHits = hits.filter((h) => h.kind === "doc");
      for (const hit of docHits) {
        const d = (docs ?? [])[hit.rowid];
        if (!d) continue;
        const sym = docSymbol(d);
        if (seen.has(sym.id)) continue;
        const coverage = [...docTermsFor(d)].filter((x) => tset.has(x)).length;
        const score = pinned || coverage <= maxCodeMatched ? 0 : Math.min(Math.max(-hit.score, coverage * 2), 10);
        out.push({ symbol: sym, score, reason: ["doc-match"], conf: "heuristic" });
        seen.add(sym.id);
      }
      for (const hit of hits) {
        if (hit.kind !== "sym") continue;
        const s = graph.symbols[hit.rowid];
        if (!s || seen.has(s.id)) continue;
        out.push({ symbol: s, score: 0, reason: ["bm25"], conf: s.conf });
        seen.add(s.id);
      }
      out.sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.nameLine - b.symbol.nameLine);
    }
  }

  return out;
}
