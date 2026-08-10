import type { Graph, SymbolFact, Edge } from "./facts";

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
  // camel/snake splits
  for (const part of s.split(/[^a-zA-Z0-9]+/)) {
    if (!part) continue;
    for (const w of part.toLowerCase().matchAll(/[a-z][a-z0-9]*|([A-Z][a-z0-9]*)/g)) out.add(w[0].toLowerCase());
    out.add(part.toLowerCase());
  }
  out.delete("");
  return [...out];
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
}

/** Extract repo-relative file paths the task text names directly. */
export function explicitFilesFromTask(task: string, files: string[]): string[] {
  const out = new Set<string>();
  const lower = task.toLowerCase();
  for (const f of files) {
    const base = f.split("/").pop()!;
    if (lower.includes(f) || lower.includes(base)) out.add(f);
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

interface ScoreState {
  score: number;
  reason: string[];
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

export function rankSymbols({ task, graph, changed, explicitFiles }: QueryInput): RankedHit[] {
  const t = terms(task);
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

  const addReason = (id: string, r: string) => {
    const st = ensure(id);
    if (!st.reason.includes(r)) st.reason.push(r);
  };

  const symTerms = (s: SymbolFact) => new Set([...terms(s.name), ...terms(s.sig), ...terms(s.doc)]);

  for (const s of graph.symbols) {
    const st = ensure(s.id);
    const terms_ = symTerms(s);
    let matched = 0;
    for (const term of t) if (terms_.has(term)) matched++;
    if (matched > 0) {
      st.score += matched * 2;
      addReason(s.id, "identifier-match");
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
    // hubs: referenced by many
    const hub = (inbound.get(s.id)?.length ?? 0) + (outbound.get(s.id)?.length ?? 0);
    st.score += hub * 0.04;
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
        ensure(e2.to).score += base * w * w2 * 0.15;
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
  return out;
}
