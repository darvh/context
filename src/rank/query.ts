import type { Graph, SymbolFact, Edge } from "../core/facts";
import type { DocFact } from "../core/doc";
import type { Bm25Index } from "../rank/bm25";
import { bm25Search } from "../rank/bm25";
import type { SemanticHit } from "../rank/semantic";
import {
  STOP_WORDS,
  RECENT_WORDS,
  TEST_INTENT,
  HISTORY_INTENT,
  NEG_TESTS,
  NEG_PRODUCTION,
  NEG_LEGACY,
  ONLY_CONFIG,
  SCOPE_UNDER,
  WEAK_BASE_SCORE,
  AUTHORITATIVE_REASONS,
  GENERIC_TEST,
  DOC_INTENT,
  isTestFile,
  expandIrregular,
} from "../core/rules";

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
  /** git co-change pairs ("fileA\0fileB" -> commit count), only consulted for
   *  explicit history/regression intent */
  coChanged?: Map<string, number>;
}

/** Transient symbol for a doc file (or one of its sections) — never stored in
 *  the graph, only for capsule rendering. The span covers the section that
 *  matched so `context expand` lands on the answer region; the sig records the
 *  section ordinal and heading when the section is heading-led. */
export function docSymbol(d: DocFact, line = 1): SymbolFact {  const name = d.file.split("/").pop() ?? d.file;
  const idx = d.sections.findIndex((s) => s.line === line);
  let sig = "";
  let endLine = line;
  if (idx >= 0) {
    const sec = d.sections[idx];
    endLine = sec.endLine || line;
    const heading = sec.text.split("\n").find((l) => l.startsWith("#"));
    sig = `section ${idx + 1}${heading ? ` · ${heading.trim().replace(/^#+\s*/, "")}` : ""}`;
  }
  return {
    id: `doc::${d.file}`,
    file: d.file,
    kind: "doc",
    name,
    sig,
    span: { sl: line, sc: 1, el: endLine, ec: 1 },
    nameLine: line,
    exported: false,
    test: false,
    doc: d.text.slice(0, 200),
    conf: "heuristic",
  };
}

/** Transient symbol for a file-only hit — never stored in the graph. Lets a
 *  symbol-less file (Makefile, LICENSE, schema.sql, an entry point) appear in
 *  the capsule: the answer to "where is the Makefile" IS the file. */
function fileSymbol(f: string): SymbolFact {
  return {
    id: `file::${f}`,
    file: f,
    kind: "file",
    name: f.split("/").pop() ?? f,
    sig: f,
    span: { sl: 1, sc: 1, el: 1, ec: 1 },
    nameLine: 1,
    exported: false,
    test: false,
    doc: "",
    conf: "heuristic",
  };
}

/** Fuse the file-only lane into symbol hits: a file the task names by
 *  basename (or that matches strongly) surfaces as a file-level hit. Gated to
 *  files with no symbol hit already — symbol answers stay authoritative; the
 *  file lane only fills the symbol-less gap. A basename match is an explicit
 *  file reference (the query names the file), so it pins above every symbol
 *  hit; weaker path/content matches append below. */
export function fuseFileHits(hits: RankedHit[], task: string, graph: Graph, files: string[], docs: DocFact[]): RankedHit[] {
  const ranked = rankFiles(task, graph, files, docs);
  if (!ranked.length) return hits;
  const hitFiles = new Set(hits.map((h) => h.symbol.file));
  const maxGraph = hits[0]?.score ?? 0;
  const out = [...hits];
  const seen = new Set(out.map((h) => h.symbol.id));
  // named pins first, so they outrank content-matched supplements even when
  // the symbol lane is empty (maxGraph=0): "the license" is LICENSE, not the
  // Readme that mentions licensing
  for (const f of ranked) {
    if (!f.reason.includes("basename-match")) continue;
    if (hitFiles.has(f.file) || seen.has(`file::${f.file}`)) continue;
    seen.add(`file::${f.file}`);
    out.push({ symbol: fileSymbol(f.file), score: maxGraph + 1 + f.score / 100, reason: f.reason.slice(0, 2), conf: "heuristic" });
  }
  for (const f of ranked.slice(0, 5)) {
    if (hitFiles.has(f.file) || seen.has(`file::${f.file}`)) continue;
    seen.add(`file::${f.file}`);
    out.push({ symbol: fileSymbol(f.file), score: Math.min(f.score * 2, maxGraph), reason: f.reason.slice(0, 2), conf: "heuristic" });
  }
  out.sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.nameLine - b.symbol.nameLine);
  return out;
}

// a base (graph+lexical) hit at or above this score is a genuine lexical
// match (several distinct query terms in one symbol). Below it, the query is
// low-confidence and semantic results lead — UNLESS an authoritative low-score
// signal (recent-change, explicit-file) already pinned the answer.
export type QueryConfidence = "strong" | "weak" | "conflicted" | "empty";

/** The confidence gate between the exact/lexical pass and the semantic lane.
 *  strong: a genuine lexical match or an authoritative signal pinned the
 *  answer — semantic adds nothing. conflicted: several hits compete near the
 *  top across different directories — show alternatives instead of a single
 *  claim. weak: hits exist but no confident match. empty: nothing matched.
 *  The gate decides whether semantic candidates are consulted at all, so a
 *  good lexical pass never pays the embedding cost. */
export function queryConfidence(hits: RankedHit[]): QueryConfidence {
  if (!hits.length) return "empty";
  const maxBase = hits[0]?.score ?? 0;
  const authoritative = hits.some((h) => h.reason.some((r) => AUTHORITATIVE_REASONS.includes(r) || r === "exact-name"));
  if (maxBase >= WEAK_BASE_SCORE || authoritative) return "strong";
  if (hits.length >= 2 && hits[1].score >= maxBase * 0.7) {
    const dirs = new Set(hits.slice(0, 2).map((h) => h.symbol.file.split("/").slice(0, -1).join("/")));
    if (dirs.size >= 2) return "conflicted";
  }
  return "weak";
}

// words that make a query explicitly about recent working-tree changes; when
// present, recent-change applies to every changed file regardless of topical
// affinity ("what did we change recently"). Without one, change is only a
// boost on top of a real match, never a ranking reason by itself.

/** Pick the section of a doc that best matches the task terms, so a semantic
 *  doc hit pinpoints the matching region instead of always defaulting to line
 *  1. Scores sections by meaningful-term overlap; ties break to the first
 *  section. Returns the selected section, or the first section when nothing
 *  matches. */
export function bestDocSection(d: DocFact, task: string): DocFact["sections"][number] | undefined {
  if (!d.sections.length) return undefined;
  const t = meaningfulTerms(task);
  if (!t.length) return d.sections[0];
  const tset = new Set(t);
  let best = d.sections[0];
  let bestScore = 0;
  for (const s of d.sections) {
    const terms_ = meaningfulTerms(s.text);
    let matched = 0;
    for (const term of terms_) if (tset.has(term)) matched++;
    if (matched > bestScore) {
      best = s;
      bestScore = matched;
    }
  }
  return best;
}

/**
 * Append semantic hits. When the graph/lexical pass is weak (no authoritative
 * signal, few/no term matches — exactly the unresolved/low-confidence queries
 * embeddings are for), semantic hits rank first, ordered by similarity. When
 * lexical has a genuine match or an authoritative signal, semantic appends
 * below it (graph stays authoritative).
 */
export function appendSemanticHits(hits: RankedHit[], sem: SemanticHit[], graph: Graph, docs: DocFact[], task: string): RankedHit[] {
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
  const simById = new Map(sem.map((s) => [s.id, s.sim]));
  if (simById.size && weak && hits.length > 0) {
    out = out.map((h) => {
      const sim = simById.get(h.symbol.id);
      if (sim === undefined) return h;
      return { ...h, score: maxBase + sim, reason: [...h.reason, "semantic"] };
    });
  } else if (simById.size && !weak) {
    // hybrid fusion: on a strong base, a BM25-appended (score-0) tail hit
    // semantics independently confirms is lifted by sim (bounded by the
    // MIN_SIM floor, stays below WEAK_BASE_SCORE) — two retrievers agreeing
    // beats either alone, without cosine reordering authoritative graph hits
    out = out.map((h) => {
      if (!h.reason.includes("bm25")) return h;
      const sim = simById.get(h.symbol.id);
      if (sim === undefined) return h;
      return { ...h, score: h.score + sim, reason: [...h.reason, "semantic"] };
    });
  }
  for (const h of sem) {
    let sym: SymbolFact | null = null;
    if (h.id.startsWith("doc::")) {
      const d = docById.get(h.id.slice(5));
      if (d) sym = docSymbol(d, bestDocSection(d, task)?.line ?? 1);
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
export function explicitFilesFromTask(task: string, files: string[]): string[] {  const out = new Set<string>();
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

export interface RankedFile {
  file: string;
  score: number;
  reason: string[];
}

/**
 * File-only search: rank repo files by query-term overlap on PATH + BASENAME
 * + aggregated symbol terms (names/sigs/docs/strings). No symbol granularity —
 * the answer is a FILE, so a symbol-less file (Makefile, LICENSE, schema.sql,
 * an entry point with no parseable symbols) can surface without any symbol
 * hit. Basename matches weigh double (a query naming "store.go" means the
 * file, wherever it lives); path tokens weigh once. Symbol terms fill in the
 * paraphrase case: "the database schema" matches schema.sql's own content.
 * Deterministic: score desc, then path.
 */
export function rankFiles(task: string, graph: Graph, files: string[], docs: DocFact[] = []): RankedFile[] {
  const rv = repoVocab(graph, docs);
  const t = meaningfulTerms(task).flatMap(expandIrregular).flatMap((term) => splitByRepoVocab(term, rv.vocab, rv.symbolCount, rv.freq, rv.cooccur));
  const tset = new Set(t);
  if (!tset.size) return [];

  // per-file aggregated content terms (symbols + strings + doc text)
  const fileContent = new Map<string, Set<string>>();
  for (const s of graph.symbols) {
    if (s.kind === "import") continue;
    let set = fileContent.get(s.file);
    if (!set) {
      set = new Set();
      fileContent.set(s.file, set);
    }
    for (const term of symTermsFor(s, graph)) set.add(term);
  }
  const docContent = new Map<string, Set<string>>();
  for (const d of docs) {
    docContent.set(d.file, docTermsFor(d));
  }

  const out: RankedFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    const pathTerms = new Set(terms(f));
    const base = f.split("/").pop() ?? f;
    const baseTerms = new Set(terms(base));
    let pathMatched = 0;
    let baseMatched = 0;
    for (const term of tset) {
      if (baseTerms.has(term)) baseMatched++;
      else if (pathTerms.has(term)) pathMatched++;
    }
    const content = fileContent.get(f) ?? docContent.get(f);
    let contentMatched = 0;
    if (content) for (const term of tset) if (content.has(term)) contentMatched++;
    if (baseMatched + pathMatched + contentMatched === 0) continue;
    // root-level entry files beat nested copies with the same basename
    // ("the index file" means index.js at the root, not examples/auth/index.js)
    const rootBonus = base === f ? 0.5 : 0;
    const score = baseMatched * 2 + pathMatched * 1.5 + contentMatched * 0.75 + rootBonus;
    const reason: string[] = [];
    // "named": the query contains the file's full basename — an explicit file
    // reference, not a partial term coincidence ("regexp.go" must not name
    // go.mod just because both contain "go"). Extensionless files match their
    // bare name (LICENSE, Makefile); dotted names need the whole token.
    const baseLower = base.toLowerCase();
    const named = tset.has(baseLower) || tset.has(f.toLowerCase());
    if (named) reason.push("basename-match");
    else if (baseMatched) reason.push("basename-partial");
    if (pathMatched) reason.push("path-match");
    if (contentMatched) reason.push("content-match");
    out.push({ file: f, score, reason });
  }
  out.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return out;
}

interface ScoreState {
  score: number;
  reason: string[];
}

// token sets are stable per graph/docs instance: memoize so N queries over one
// build tokenize each symbol/doc exactly once instead of per query
const symTermsMemo = new WeakMap<Graph, Map<string, Set<string>>>();
const fileTermsMemo = new WeakMap<Graph, Map<string, Set<string>>>();
const docTermsMemo = new WeakMap<DocFact, Set<string>>();

/** Path tokens for a file: identical for every symbol in the file, so compute
 *  once per file per build instead of once per symbol. */
function fileTermsFor(s: SymbolFact, graph: Graph): Set<string> {
  let m = fileTermsMemo.get(graph);
  if (!m) {
    m = new Map();
    fileTermsMemo.set(graph, m);
  }
  let t = m.get(s.file);
  if (!t) {
    t = new Set(terms(s.file));
    m.set(s.file, t);
  }
  return t;
}

function symTermsFor(s: SymbolFact, graph: Graph): Set<string> {
  let m = symTermsMemo.get(graph);
  if (!m) {
    m = new Map();
    symTermsMemo.set(graph, m);
  }
  let t = m.get(s.id);
  if (!t) {
    t = new Set([...terms(s.name), ...terms(s.sig), ...terms(s.doc), ...(s.strings ?? []).flatMap(terms)]);
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

/** Repo-driven compound split: an unseparated query token ("treesitter")
 *  that matches nothing is split at every point where BOTH halves exist in
 *  the repository's own term vocabulary ("tree" + "sitter" from a
 *  "tree-sitter" comment). No hardcoded lexicon — the repo decides which
 *  joined words are meaningful. Deterministic: first valid split scanning
 *  left-longest. A half that is ubiquitous (appears in more than a third of
 *  symbols, e.g. "line") cannot anchor a split, so "deadline" never becomes
 *  dead+line. */
export function splitByRepoVocab(term: string, vocab: Set<string>, symbolCount: number, freq: Map<string, number>, cooccur: Set<string>): string[] {
  if (vocab.has(term) || term.length < 6) return [term];
  const maxFreq = Math.max(2, Math.ceil(symbolCount / 3));
  for (let i = 3; i <= term.length - 3; i++) {
    const a = term.slice(0, i);
    const b = term.slice(i);
    const key = a < b ? `${a}\0${b}` : `${b}\0${a}`; // cooccur stores pairs alphabetically
    if (vocab.has(a) && vocab.has(b) && cooccur.has(key) && (freq.get(a) ?? 0) <= maxFreq && (freq.get(b) ?? 0) <= maxFreq) return [term, a, b];
  }
  return [term];
}

/** Repository term vocabulary + per-term symbol frequency, memoized per graph.
 *  Terms come from the same per-symbol term sets ranking already uses. */
/** All observed term pairs of a bounded term set (alphabetical key). */
function addPairs(terms: string[], cooccur: Set<string>): void {
  const arr = terms.slice(0, 60); // bound: one dense file cannot explode pairs
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i];
      const b = arr[j];
      cooccur.add(a < b ? `${a}\0${b}` : `${b}\0${a}`);
    }
  }
}

const vocabMemo = new WeakMap<Graph, { vocab: Set<string>; freq: Map<string, number>; cooccur: Set<string> }>();
export function repoVocab(graph: Graph, docs: DocFact[]): { vocab: Set<string>; freq: Map<string, number>; cooccur: Set<string>; symbolCount: number } {
  let m = vocabMemo.get(graph);
  if (!m) {
    m = { vocab: new Set(), freq: new Map(), cooccur: new Set() };
    const fileTerms = new Map<string, Set<string>>();
    for (const s of graph.symbols) {
      if (s.kind === "import") continue;
      const terms_ = symTermsFor(s, graph);
      for (const term of terms_) {
        m.vocab.add(term);
        m.freq.set(term, (m.freq.get(term) ?? 0) + 1);
      }
      // co-occurrence is observed at FILE level: a joined word's halves are
      // meaningful when the repo uses them together in one file (phrases span
      // symbols), which still rejects accidental halves in unrelated files
      let ft = fileTerms.get(s.file);
      if (!ft) {
        ft = new Set();
        fileTerms.set(s.file, ft);
      }
      for (const term of terms_) ft.add(term);
    }
    for (const [, ft] of fileTerms) addPairs([...ft], m.cooccur);
    for (const d of docs) {
      const terms_ = [...docTermsFor(d)];
      for (const term of terms_) m.vocab.add(term);
      // docs count as co-occurrence too: phrases like "view engine" live in
      // markdown, not in symbol comments
      addPairs(terms_, m.cooccur);
    }
    vocabMemo.set(graph, m);
  }
  const symbols = graph.symbols.filter((s) => s.kind !== "import").length;
  return { vocab: m.vocab, freq: m.freq, cooccur: m.cooccur, symbolCount: symbols || 1 };
}

export function rankSymbols({ task, graph, changed, explicitFiles, bm25, docs, coChanged }: QueryInput): RankedHit[] {
  // irregular-form + repo-driven compound expansion: "kept" also matches
  // "keep", and "treesitter" splits into repo vocabulary ("tree"+"sitter")
  // when the joined token matches nothing
  const rv = repoVocab(graph, docs ?? []);
  const t = meaningfulTerms(task).flatMap(expandIrregular).flatMap((term) => splitByRepoVocab(term, rv.vocab, rv.symbolCount, rv.freq, rv.cooccur));
  const tset = new Set(t);
  const recentIntent = t.some((w) => RECENT_WORDS.has(w));
  const historyIntent = HISTORY_INTENT.test(task);
  const taskLower = task.toLowerCase();
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
    // diagnostic-first: a task naming a test verbatim pins it (stack traces,
    // failing-test reports, CI output) — stronger than a term match
    if (s.test && s.name.length >= 6 && taskLower.includes(s.name.toLowerCase())) {
      st.score += 6;
      addReason(s.id, "test-name-pin");
    }
    // path match
    const fileTerms = fileTermsFor(s, graph);
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
    // recent changes only boost files the task is already about (topical
    // affinity or an explicit recent-work query). A dirty tree must not make
    // every symbol in a touched file relevant on its own.
    const affinity = matched > 0 || pathMatched > 0 || explicit;
    if (changed.has(s.file) && (affinity || recentIntent)) {
      st.score += 1.2;
      addReason(s.id, "recent-change");
    }
    // kind/hub bonuses only when some lexical or change signal exists,
    // so unrelated queries stay empty instead of surfacing noise
    const relevant = affinity || (recentIntent && changed.has(s.file));
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

  // negative constraints: excluded scopes are penalized before propagation,
  // so they never seed the graph
  const negTests = NEG_TESTS.test(task) || NEG_PRODUCTION.test(task);
  const negLegacy = NEG_LEGACY.test(task);
  const onlyConfig = ONLY_CONFIG.test(task);
  const scopeUnder = SCOPE_UNDER.exec(task)?.[1];
  if (negTests || negLegacy || onlyConfig || scopeUnder) {
    for (const [id, st] of state) {
      const s = byId.get(id);
      if (!s) continue;
      if (negTests && s.test) st.score *= 0.05;
      if (negLegacy && /legacy/i.test(s.file)) st.score *= 0.2;
      if (onlyConfig && s.kind !== "config") st.score *= 0.4;
      if (scopeUnder && !s.file.startsWith(scopeUnder.replace(/\/$/, "") + "/")) st.score *= 0.3;
    }
  }

  // git co-change lane: only for explicit history/regression intent, and only
  // from files that changed today to their historical co-changers
  if (historyIntent && coChanged && coChanged.size) {
    const boost = (f: string, count: number) => {
      for (const s of graph.symbols) {
        if (s.file !== f) continue;
        const st = ensure(s.id);
        st.score += Math.min(count, 5) * 0.6;
        addReason(s.id, "co-change");
      }
    };
    for (const [pair, count] of coChanged) {
      const sep = pair.indexOf("\0");
      const a = pair.slice(0, sep);
      const b = pair.slice(sep + 1);
      if (changed.has(a) && !changed.has(b)) boost(b, count);
      else if (changed.has(b) && !changed.has(a)) boost(a, count);
    }
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
  // test scaffolding (conftest fixtures, *_test.go, tests/) is evidence, not
  // an answer: without explicit test/defect/change intent it must not outrank
  // the real code, so its hits are dampened after propagation.
  const demoteTests = !TEST_INTENT.test(taskLower) && !recentIntent && !historyIntent && explicitFiles.length === 0;
  for (const s of graph.symbols) {
    const st = state.get(s.id);
    if (!st || st.score <= 0) continue;
    const score = demoteTests && isTestFile(s.file) ? st.score * 0.6 : st.score;
    if (score <= 0) continue;
    out.push({ symbol: s, score, reason: st.reason.slice(0, 4), conf: s.conf });
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
      // 0 — the graph lane stays authoritative.
      // explicit change/history intent pins the code answer too — a doc must
      // not outrank "where was this edited" queries
      const pinned = recentIntent || historyIntent || out.some((h) => h.reason.some((r) => AUTHORITATIVE_REASONS.includes(r) || r === "exact-name"));
      const docIntent = DOC_INTENT.test(taskLower);
      const maxGraph = out[0]?.score ?? 0;
      // a doc may only outrank code when the query asks for docs explicitly
      // (doc-intent words) or the code lane has no genuine answer. On a strong
      // non-doc query, a reference doc that happens to cover all terms must
      // not bury the code answer ("how are session cookies signed" -> the
      // implementation, not docs/api.rst).
      const docLeads = docIntent || maxGraph < WEAK_BASE_SCORE;
      const docHits = hits.filter((h) => h.kind === "doc");
      for (const hit of docHits) {
        const d = (docs ?? [])[hit.doc ?? -1];
        if (!d) continue;
        const sec = d.sections[hit.section ?? 0];
        const sym = docSymbol(d, sec?.line ?? 1);
        if (seen.has(sym.id)) continue;
        const coverage = [...docTermsFor(d)].filter((x) => tset.has(x)).length;
        // a doc that covers MORE query terms than any code symbol IS the
        // answer: on doc-intent queries it ranks above every graph hit
        // (maxGraph+1), with the BM25 score as a fractional tiebreak among
        // qualifying docs. Otherwise it keeps a capped BM25 score below the
        // code. Gated docs (pinned answer / no coverage edge / strong code
        // lane) append at 0.
        const gated = pinned || !docLeads || coverage <= maxCodeMatched;
        const score = gated
          ? 0
          : docIntent
            ? maxGraph + 1 + Math.min(-hit.score, 20) / 100
            : Math.min(Math.max(-hit.score, coverage * 2), 10);
        out.push({ symbol: sym, score, reason: ["doc-match"], conf: "heuristic" });
        seen.add(sym.id);
      }
      for (const hit of hits) {
        if (hit.kind !== "sym") continue;
        const s = graph.symbols[hit.rowid];
        // imports are evidence edges, never ranking targets — the bm25 lane
        // must not re-admit them as hits
        if (!s || s.kind === "import" || seen.has(s.id)) continue;
        out.push({ symbol: s, score: 0, reason: ["bm25"], conf: s.conf });
        seen.add(s.id);
      }
      out.sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.nameLine - b.symbol.nameLine);
    }
  }

  return out;
}
