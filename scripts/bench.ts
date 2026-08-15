import { promises as fs } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import pkg from "../package.json" with { type: "json" };
import { build } from "../src/build";
import { rankSymbols, terms, appendSemanticHits } from "../src/query";
import { buildBm25Index, bm25Query } from "../src/bm25";
import { assemble } from "../src/assemble";
import { repoKey } from "../src/cache";
import { semanticEnabled, semanticSearch } from "../src/semantic";
import type { BuildResult } from "../src/build";
import type { RankedHit } from "../src/query";

/**
 * On-demand retrieval bench. Corpus = REAL data (cloned public repos + real
 * multi-format documents: pdf/epub/docx, converted by anydoc) MIXED with
 * synthetic adversarial code + markdown ("beyond-life" data: dense files,
 * near-duplicate names, planted needle facts). Queries range from easy symbol
 * hits to paraphrase needles and cross-format lookups. Reports Recall@k, MRR,
 * and latency grouped by difficulty, baseline vs hybrid (and semantic when
 * enabled).
 *
 * Every run writes the corpus MANIFEST (seed, environment, versions, full task
 * list), RAW per-task results, and a FAILURE CORPUS (every confirmed miss) to
 * var/bench-<seed>-<size>/ so retrieval changes are reproducible and misses
 * are preserved before any ranking change. Declared latency/memory/index
 * budgets are enforced per size and warn when exceeded.
 *
 *   bun run bench                    # synthetic only (medium)
 *   bun run bench --size small|large
 *   bun run bench --real             # + cloned repos + real downloaded docs
 *   bun run bench --seed 42 --semantic
 *   bun run bench --semantic --models "A,B"   # compare models on hard slices
 */

const SIZES: Record<string, number> = { small: 10, medium: 40, large: 120 };
const args = process.argv.slice(2);
const sizeI = args.indexOf("--size");
const sizeName = sizeI >= 0 ? args[sizeI + 1] : (args.find((a) => a.startsWith("--size=")) ?? "").split("=")[1] ?? "medium";
const size = SIZES[sizeName] ?? SIZES.medium;
const seed = Number(args.find((a) => a.startsWith("--seed="))?.split("=")[1] ?? 7);
const useSemantic = args.includes("--semantic") || (await semanticEnabled());
const useReal = args.includes("--real");
const modelsArg = args.find((a) => a.startsWith("--models="))?.split("=")[1];
const compareModels = useSemantic && modelsArg ? modelsArg.split(",").map((s) => s.trim()).filter(Boolean) : [];

// declared budgets per size: a retrieval change ships only when it holds these
// on the pinned corpus. Loose on purpose: CI machines vary more than laptops.
const BUDGETS: Record<string, { indexKb: number; coldP95Ms: number; warmP95Ms: number; peakRssMb: number }> = {
  small: { indexKb: 400, coldP95Ms: 4000, warmP95Ms: 1000, peakRssMb: 512 },
  medium: { indexKb: 1500, coldP95Ms: 10000, warmP95Ms: 2500, peakRssMb: 1024 },
  large: { indexKb: 6000, coldP95Ms: 30000, warmP95Ms: 8000, peakRssMb: 2048 },
};

// deterministic RNG
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GenTask {
  id: string;
  type: "symbol" | "concept" | "needle" | "needle-lexical" | "cross-format" | "doc-format" | "ambiguous" | "path" | "change";
  source: "synthetic" | "real";
  query: string;
  expectedFiles: string[];
  topK: number;
  changed?: string[];
}

interface Corpus {
  files: Map<string, string>;
  tasks: GenTask[];
}

const CAPS = ["payment", "search", "cache", "auth", "notifications", "metrics", "inventory", "reporting", "sessions", "billing"];

// hard facts planted in exactly one place; the query is a paraphrase sharing
// NO content term with the fact (checked against the real porter index — see
// porterHard below), so only semantic/context understanding recovers it
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are", "was", "be", "it", "its", "for", "with", "at", "from", "by", "how", "what", "when", "where", "why", "do", "does", "we", "they", "that", "this", "as"]);
const NEEDLES = [
  { fact: "auth tokens rotate on a fixed schedule and never reuse an older secret", query: "why do my logins suddenly stop being accepted after some time?" },
  { fact: "the load balancer drains connections for ten seconds before removing a host", query: "how long does a server keep accepting traffic after it is marked to be taken down?" },
  { fact: "backups run at two in the morning and keep the last fourteen snapshots", query: "what is the retention window for the nightly archive?" },
  { fact: "the upload endpoint rejects anything over two hundred megabytes and refuses compressed bundles", query: "why do big transfers bounce before completing?" },
  { fact: "email delivery retries every hour and gives up after four attempts", query: "how many times do we try sending before a message is marked failed?" },
  { fact: "schema updates execute sequentially and skip nodes already updated", query: "is there a guard against applying the same change twice?" },
  { fact: "the watchdog restarts a worker that misses several pings in a row", query: "how many lost signals before a job gets recycled?" },
];

/** True when the query cannot lexically reach the fact through the REAL
 * retrieval tokenizer (porter + stopword filter). Mirrors bm25Query exactly,
 * so a needle can never be called hard while the hybrid lane solves it. */
function porterHard(fact: string, query: string): boolean {
  const db = new Database(":memory:");
  db.run(`CREATE VIRTUAL TABLE t USING fts5(text, tokenize='porter')`);
  db.prepare(`INSERT INTO t(text) VALUES (?)`).run(fact);
  const hits = db.prepare(`SELECT rowid FROM t WHERE t MATCH ? LIMIT 1`).all(bm25Query(query));
  return hits.length === 0;
}

function genModule(mod: string, rng: () => number, neighbor: string): { files: Map<string, string>; symbols: string[] } {
  const Cap = mod[0].toUpperCase() + mod.slice(1);
  const Nbr = neighbor[0].toUpperCase() + neighbor.slice(1);
  const files = new Map<string, string>();
  const symbols = [`Open${Cap}`, `Get${Cap}`, `Set${Cap}`, `Delete${Cap}`, `Refresh${Cap}`, `Handle${Cap}Event`];

  // package-level var named like the package: gives the import/qualifier call
  // edges a unique go-only target so they RESOLVE (Open${Nbr} exists in 3
  // languages and stays genuinely ambiguous)
  let go = `package ${mod}\n\nimport (\n\t"errors"\n\t"${neighbor}"\n)\n\n`;
  go += `type ${Cap}Store struct{ path string }\n\n`;
  go += `var ${mod} = &${Cap}Store{}\n\n`;
  symbols.forEach((sym, i) => {
    const body = sym === `Handle${Cap}Event` ? `\treturn ${neighbor}.Open${Nbr}(key)` : `\treturn "", errors.New("not implemented")`;
    go += `// ${sym} ${mod}s the ${Cap} record.\nfunc ${sym}(key string) (string, error) {\n${body}\n}\n\n`;
  });
  files.set(`code/${mod}.go`, go);

  let ts = `// ${Cap} module: ${mod} operations.\n`;
  symbols.forEach((sym) => {
    ts += `export function ${sym}(key: string): Promise<string | null> {\n  return Promise.resolve(null);\n}\n\n`;
  });
  files.set(`code/${mod}.ts`, ts);

  const lower = symbols.map((s) => s[0].toLowerCase() + s.slice(1));
  let py = `"""${Cap} module: ${mod} operations."""\n`;
  lower.forEach((sym, i) => {
    py += i % 3 === 0 ? `def ${sym}(key: str) -> str | None:\n    """${mod} the ${Cap} record."""\n    return None\n\n` : `def ${sym}(key: str) -> str | None:\n    return None\n\n`;
  });
  files.set(`code/${mod}.py`, py);

  return { files, symbols };
}

/** beyond-life data: one dense file + near-duplicate names to stress disambiguation */
function genAdversarial(): Map<string, string> {
  const files = new Map<string, string>();
  let blob = "package blob\n\n";
  for (let i = 0; i < 600; i++) blob += `// BlobItem${i} does a thing.\nfunc BlobItem${i}(k string) error { return nil }\n\n`;
  files.set("code/blob.go", blob);

  let dup = "package dup\n\n";
  for (const n of ["PaymentProcess", "ProcessPayment", "PaymentProceed", "PaymentProcessing", "PayProcess"]) {
    dup += `// ${n} handles money movement.\nfunc ${n}(a, b string) (string, error) { return b, nil }\n\n`;
  }
  files.set("code/dup.go", dup);

  // near-duplicate "cache" decoys: the ambiguous query `cache` must now pick
  // the real cache module out of 12 impostor files (name-only matches) — real
  // overload, not a guaranteed 4-candidate pass
  for (let i = 0; i < 12; i++) {
    let dec = `package cacheish${i}\n\n`;
    for (const n of [`CacheEntry${i}`, `CacheLookup${i}`, `CacheStore${i}`]) {
      dec += `// ${n} manages cached values.\nfunc ${n}(k string) error { return nil }\n\n`;
    }
    files.set(`code/cacheish${i}.go`, dec);
  }
  return files;
}

function genMd(mod: string, symbols: string[]): string {
  const Cap = mod[0].toUpperCase() + mod.slice(1);
  return `# ${Cap} guide\n\n## Overview\n\nThe ${mod} subsystem stores and manages ${mod} records. Key entry points are ` +
    symbols.slice(0, 4).join(", ") + `.\n\n## Configuration\n\nDefaults are fine for most deployments.\n\n## Troubleshooting\n\nCheck the ${mod} logs first.\n`;
}

function generate(seedN: number, modules: number): Corpus {
  const rng = mulberry32(seedN);
  const files = new Map<string, string>();
  const tasks: GenTask[] = [];
  const needleHomes = new Map<number, string[]>();
  const needleQueries = new Map<number, string>();
  const selected = Array.from({ length: modules }, (_, i) => CAPS[i % CAPS.length] + (i >= CAPS.length ? String(i) : ""));

  for (const [i, mod] of selected.entries()) {
    const neighbor = selected[(i + 1) % modules];
    const { files: modFiles, symbols } = genModule(mod, rng, neighbor);
    for (const [p, c] of modFiles) files.set(p, c);
    files.set(`docs/${mod}.md`, genMd(mod, symbols));
    // the go symbol's doc comment uniquely carries the "<mod>s" term, so the
    // query disambiguates go/ts/py instead of falling back to byte-order ties
    for (const sym of symbols.slice(0, 2)) {
      tasks.push({ id: `sym-${mod}-${sym}`, type: "symbol", source: "synthetic", query: `${sym} ${mod}s`, expectedFiles: [`code/${mod}.go`], topK: 3 });
    }
    tasks.push({
      id: `con-${mod}`,
      type: "concept",
      source: "synthetic",
      query: `how does ${mod} record handling work and where is it wired`,
      expectedFiles: [`code/${mod}.go`, `code/${mod}.ts`],
      topK: 5,
    });
    // explicit path query (tests explicitFilesFromTask, like production)
    tasks.push({
      id: `path-${mod}`,
      type: "path",
      source: "synthetic",
      query: `fix the bug in code/${mod}.go`,
      expectedFiles: [`code/${mod}.go`],
      topK: 3,
    });
    // change query: the changed file gets the recent-change signal
    tasks.push({
      id: `chg-${mod}`,
      type: "change",
      source: "synthetic",
      query: `${mod} handling was just edited, where do we look first`,
      expectedFiles: [`code/${mod}.go`],
      topK: 5,
      changed: [`code/${mod}.go`],
    });
    // doc-lane retrieval: the answer lives only in the module's markdown
    tasks.push({
      id: `doc-${mod}`,
      type: "cross-format",
      source: "synthetic",
      query: `how do I configure ${mod} and what are the defaults`,
      expectedFiles: [`docs/${mod}.md`],
      topK: 5,
    });
    // one planted needle per module; the expected file is the exact home.
    // code needles go directly above the first function so docAbove attaches
    // them to a symbol (and semantic embeds them); md needles go in the doc.
    // A needle is only "hard" when its query cannot reach the fact through the
    // REAL porter tokenizer (porterHard); a lexically solvable needle is
    // classified needle-lexical so the class stays honest. The SAME fact is
    // planted in several modules, so any of its homes is a correct answer.
    const n = NEEDLES[i % NEEDLES.length];
    const loc = i % 2 === 0 ? "code" : "md";
    const home = loc === "code" ? `code/${mod}.go` : `docs/${mod}.md`;
    if (loc === "code") {
      const go = files.get(`code/${mod}.go`)!;
      files.set(`code/${mod}.go`, go.replace(`func ${symbols[0]}(`, `// ${n.fact}\nfunc ${symbols[0]}(`));
    } else {
      files.set(`docs/${mod}.md`, files.get(`docs/${mod}.md`)! + `\n## Operations\n\n${n.fact}\n`);
    }
    needleHomes.set(i % NEEDLES.length, [...(needleHomes.get(i % NEEDLES.length) ?? []), home]);
    needleQueries.set(i % NEEDLES.length, n.query);
  }

  // one task per distinct needle (the old per-module push measured the same
  // query N times); soft needles are classified, not silently overclaimed
  for (const [idx, query] of needleQueries) {
    const hard = porterHard(NEEDLES[idx].fact, query);
    const type = hard ? "needle" : "needle-lexical";
    if (!hard) console.log(`bench: WARN needle #${idx} solvable by BM25 (porter) — classified ${type}`);
    tasks.push({ id: `ndl-${idx}`, type, source: "synthetic", query, expectedFiles: needleHomes.get(idx)!, topK: 5 });
  }

  for (const [p, c] of genAdversarial()) files.set(p, c);
  tasks.push({ id: "amb-cache", type: "ambiguous", source: "synthetic", query: "cache", expectedFiles: [`code/cache.go`, `code/cache.ts`, `code/cache.py`, `docs/cache.md`], topK: 8 });

  return { files, tasks };
}

// ---- real data ----

const REAL_REPOS: { name: string; url: string }[] = [
  { name: "gorilla-mux", url: "https://github.com/gorilla/mux.git" },
  { name: "express", url: "https://github.com/expressjs/express.git" },
  { name: "flask", url: "https://github.com/pallets/flask.git" },
];

// stable public documents of many real formats (converted by anydoc in prod)
const REAL_DOCS: { name: string; url: string }[] = [
  { name: "attention.pdf", url: "https://arxiv.org/pdf/1706.03762" },
  { name: "pride-and-prejudice.epub", url: "https://www.gutenberg.org/cache/epub/1342/pg1342.epub" },
  { name: "file-sample.docx", url: "https://file-examples.com/storage/fe33a5a0e22a711b4db3bb9d/2017/02/file-sample_100kB.docx" },
];

const MAX_DL = 25 * 1024 * 1024;

async function downloadReal(outDir: string): Promise<{ repos: string[]; docs: string[] }> {
  const repos: string[] = [];
  const docs: string[] = [];
  for (const r of REAL_REPOS) {
    const dst = path.join(outDir, "real", r.name);
    try {
      const p = Bun.spawn({ cmd: ["git", "clone", "--depth", "1", "-q", r.url, dst], stdout: "pipe", stderr: "pipe" });
      if ((await p.exited) === 0) repos.push(r.name);
      else console.log(`bench: skip repo ${r.name} (clone failed)`);
    } catch {
      console.log(`bench: skip repo ${r.name} (clone failed)`);
    }
  }
  for (const d of REAL_DOCS) {
    const dst = path.join(outDir, "realdocs", d.name);
    try {
      const res = await fetch(d.url, { redirect: "follow" });
      if (!res.ok || Number(res.headers.get("content-length") ?? 0) > MAX_DL) throw new Error("bad response");
      const buf = new Uint8Array(await res.arrayBuffer());
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst, buf);
      docs.push(`realdocs/${d.name}`);
      console.log(`bench: downloaded ${d.name} (${(buf.byteLength / 1024).toFixed(0)}KB)`);
    } catch {
      console.log(`bench: skip doc ${d.name} (download failed)`);
    }
  }
  return { repos, docs };
}

/** Pick the sentence whose terms are most distinctive to its doc across the corpus. */
function pickDistinctiveSentence(text: string, freq: Map<string, number>): string {
  const candidates = text
    .split(/\n+/)
    .map((s) => s.replace(/[#*`>\-]/g, "").trim())
    .filter((s) => {
      const w = s.split(/\s+/);
      return w.length >= 8 && w.length <= 30;
    })
    // skip command/CI/config lines — they are not prose the retrieval is
    // supposed to recover ("run: go test race cover profile=..." from yaml)
    .filter((s) => !/[=]|\.\/|:\s|->|\(\)/.test(s));
  let best = "";
  let bestScore = -1;
  for (const s of candidates) {
    const ts = terms(s).filter((t) => t.length > 2 && !STOP.has(t));
    const uniq = ts.filter((t) => (freq.get(t) ?? 0) === 1).length;
    const score = uniq - (ts.length - uniq) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** Real code: symbol + concept tasks from actual downloaded content. */
function realCodeTasks(b: BuildResult, repos: string[]): GenTask[] {
  const tasks: GenTask[] = [];
  const freq = new Map<string, number>();
  for (const d of b.docs) for (const t of terms(d.text)) freq.set(t, (freq.get(t) ?? 0) + 1);
  for (const repo of repos) {
    const prefix = `real/${repo}/`;
    const seenSym = new Set<string>();
    for (const s of b.graph.symbols) {
      if (!s.file.startsWith(prefix) || s.kind === "import" || s.name.length < 3 || seenSym.has(s.name)) continue;
      seenSym.add(s.name);
      tasks.push({ id: `real-sym-${repo}-${s.name}`, type: "symbol", source: "real", query: s.name, expectedFiles: [s.file], topK: 3 });
      if (seenSym.size >= 4) break;
    }
    let docs = 0;
    for (const d of b.docs) {
      // changelogs describe changes that the CODE implements — the code is the
      // better answer, so skip them as doc-concept targets
      if (!d.file.startsWith(prefix) || /history|changelog|changes/i.test(d.file) || d.text.trim().length < 200) continue;
      const sent = pickDistinctiveSentence(d.text, freq);
      if (!sent) continue;
      tasks.push({ id: `real-doc-${repo}-${d.file.replace(/[^\w]+/g, "-")}`, type: "concept", source: "real", query: sent.slice(0, 160), expectedFiles: [d.file], topK: 5 });
      if (++docs >= 4) break;
    }
  }
  return tasks;
}

/**
 * Real multi-format docs: queries derived from their actual text. The query is
 * the doc's own sentence (verbatim), so this class tests extraction + doc-lane
 * indexing end to end — it is NOT a paraphrase-hard retrieval test, hence the
 * distinct doc-format label.
 */
function realDocTasks(b: BuildResult, docFiles: string[]): GenTask[] {
  const tasks: GenTask[] = [];
  const freq = new Map<string, number>();
  for (const d of b.docs) for (const t of terms(d.text)) freq.set(t, (freq.get(t) ?? 0) + 1);
  for (const f of docFiles) {
    const d = b.docs.find((x) => x.file === f);
    if (!d || d.text.trim().length < 200) continue;
    const best = pickDistinctiveSentence(d.text, freq);
    if (!best) continue;
    tasks.push({ id: `real-docx-${f.replace(/[^\w]+/g, "-")}`, type: "doc-format", source: "real", query: best.slice(0, 160), expectedFiles: [f], topK: 5 });
  }
  return tasks;
}

// ---- eval loop ----

function percentiles(ms: number[]): { p50: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: p(0.5), p95: p(0.95) };
}

interface PerTask {
  id: string;
  type: string;
  query: string;
  expectedFiles: string[];
  topFiles: string[];
  recall: number;
  mrr: number;
}

async function runTasks(
  corpus: Corpus,
  b: BuildResult,
  hybrid: boolean,
  semantic: boolean,
): Promise<{ byType: Map<string, { recall: number[]; mrr: number[] }>; lat: number[]; peakRssMb: number; perTask: PerTask[] }> {
  const bm25 = hybrid ? buildBm25Index(b.graph, b.docs) : undefined;
  const byType = new Map<string, { recall: number[]; mrr: number[] }>();
  const lat: number[] = [];
  const perTask: PerTask[] = [];
  const rk = repoKey(b.root);
  let peakRss = 0;

  for (const t of corpus.tasks) {
    const t0 = performance.now();
    const explicitFiles = (await import("../src/query")).explicitFilesFromTask(t.query, b.files);
    let hits: RankedHit[] = rankSymbols({ task: t.query, graph: b.graph, changed: new Set(t.changed ?? []), explicitFiles, bm25, docs: b.docs });
    if (semantic) {
      const cap = assemble({ task: t.query, build: b, hits, budgetTokens: 1200 });
      if (cap.unresolvedTerms.length > 0) {
        const sem = await semanticSearch(b.root, b.graph, b.docs, t.query, { repoKey: rk });
        if (sem?.length) hits = appendSemanticHits(hits, sem, b.graph, b.docs);
      }
    }
    lat.push(performance.now() - t0);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    const topFiles = [...new Set(hits.slice(0, t.topK).map((h) => h.symbol.file))];
    // multi-answer tasks (a fact planted in several files): any home in top-k
    // is a hit; MRR is the best home's rank
    const any = t.expectedFiles.some((f) => topFiles.includes(f));
    const recall = any ? 1 : 0;
    const rank = t.expectedFiles.reduce((best, f) => {
      const i = topFiles.indexOf(f);
      return i >= 0 && (best === 0 || i < best) ? i + 1 : best;
    }, 0);
    const st = byType.get(t.type) ?? { recall: [], mrr: [] };
    st.recall.push(recall);
    st.mrr.push(rank ? 1 / rank : 0);
    byType.set(t.type, st);
    perTask.push({ id: t.id, type: t.type, query: t.query, expectedFiles: t.expectedFiles, topFiles, recall, mrr: rank ? 1 / rank : 0 });
  }
  return { byType, lat, peakRssMb: peakRss / (1024 * 1024), perTask };
}

function report(
  name: string,
  r: Awaited<ReturnType<typeof runTasks>>,
  b: BuildResult,
  indexBytes: number,
  base?: Awaited<ReturnType<typeof runTasks>>,
  budgetName = sizeName,
) {
  console.log(`\n[${name}]`);
  const allR = [...r.byType.values()].flatMap((s) => s.recall);
  const allM = [...r.byType.values()].flatMap((s) => s.mrr);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const { p50, p95 } = percentiles(r.lat);
  console.log(`  recall@k: ${(mean(allR) * 100).toFixed(1)}%   mrr: ${mean(allM).toFixed(3)}   latency p50 ${p50.toFixed(0)}ms p95 ${p95.toFixed(0)}ms`);
  console.log(`  resources: index ${(indexBytes / 1024).toFixed(1)}KB  peak rss ${r.peakRssMb.toFixed(0)}MB  cache ${(b.cacheBytes / 1024).toFixed(1)}KB  doc-conv ${b.docMs.toFixed(0)}ms`);
  for (const [type, st] of r.byType) {
    const miss = st.recall.filter((x) => x === 0).length;
    console.log(`    ${type.padEnd(13)} recall ${(mean(st.recall) * 100).toFixed(0).padStart(3)}%  mrr ${mean(st.mrr).toFixed(2).padStart(5)}  miss ${miss}/${st.recall.length}`);
  }
  const bd = BUDGETS[budgetName];
  const over: string[] = [];
  if (bd) {
    // the ONNX runtime alone costs ~700MB resident; a semantic run cannot be
    // held to the lexical lane's memory budget
    const rssBudget = bd.peakRssMb + (useSemantic ? 800 : 0);
    if (indexBytes > bd.indexKb * 1024) over.push(`index ${(indexBytes / 1024).toFixed(0)}KB > ${bd.indexKb}KB`);
    if (p95 > bd.warmP95Ms) over.push(`p95 ${p95.toFixed(0)}ms > ${bd.warmP95Ms}ms`);
    if (r.peakRssMb > rssBudget) over.push(`rss ${r.peakRssMb.toFixed(0)}MB > ${rssBudget}MB`);
    if (over.length) console.log(`  WARN budget (${budgetName}): ${over.join(", ")}`);
  }
  // a hybrid must never rank worse than baseline on the same tasks
  if (base) {
    const regress: string[] = [];
    const baseMean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    for (const [type, st] of r.byType) {
      const bs = base.byType.get(type);
      if (!bs || !bs.recall.length) continue;
      // an mrr comparison is noise when the base retrieves nothing
      const baseRecall = baseMean(bs.recall);
      if (baseRecall <= 0) continue;
      if (mean(st.mrr) < baseMean(bs.mrr) - 0.01) regress.push(`${type} mrr ${mean(st.mrr).toFixed(2)}<${baseMean(bs.mrr).toFixed(2)}`);
      if (mean(st.recall) < baseRecall - 0.01) regress.push(`${type} recall ${(mean(st.recall) * 100).toFixed(0)}%<${(baseRecall * 100).toFixed(0)}%`);
    }
    if (regress.length) console.log(`  WARN hybrid regressed vs baseline: ${regress.join("; ")}`);
  }
}

const outDir = path.join(import.meta.dir, "..", "var", `bench-${seed}-${size}${useReal ? "-real" : ""}`);
const corpus = generate(seed, size);

await fs.rm(outDir, { recursive: true, force: true });
for (const [p, c] of corpus.files) {
  const abs = path.join(outDir, p);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, c);
}

let realRepos: string[] = [];
let realDocs: string[] = [];
if (useReal) {
  ({ repos: realRepos, docs: realDocs } = await downloadReal(outDir));
}

console.log(`bench: corpus=${corpus.files.size} files + ${realRepos.length} repos + ${realDocs.length} real docs, ${corpus.tasks.length} base tasks, seed=${seed}, semantic=${useSemantic}`);

const t0 = performance.now();
const b = await build(outDir);
console.log(`bench: build ${(performance.now() - t0).toFixed(0)}ms (symbols=${b.graph.symbols.length}, docs=${b.docs.length})`);

if (useReal) {
  // synthetic cross-format tasks whose module name collides with a real-repo
  // basename (flask/src/flask/sessions.py vs docs/sessions.md) are genuinely
  // ambiguous: real code is a legitimate answer the task never expected
  corpus.tasks = corpus.tasks.filter((t) => {
    if (t.source !== "synthetic" || t.type !== "cross-format") return true;
    const mod = t.expectedFiles[0].split("/").pop()!.replace(/\.md$/, "").toLowerCase();
    return !b.files.some((f) => f.startsWith("real/") && f.split("/").pop()!.toLowerCase().includes(mod));
  });
  corpus.tasks.push(...realCodeTasks(b, realRepos));
  corpus.tasks.push(...realDocTasks(b, realDocs));
}

const base = await runTasks(corpus, b, false, false);
const bm25only = await runTasks(corpus, b, true, false);
const hybrid = useSemantic ? await runTasks(corpus, b, true, true) : bm25only;
report("baseline (graph+lexical)", base, b, 0);
report("hybrid (+bm25)", bm25only, b, buildBm25Index(b.graph, b.docs).sizeBytes, base);
// semantic must never rank worse than bm25-only on the same tasks: the
// guard above only compares vs baseline, so a semantic displacement (a
// correct bm25 doc hit pushed out by semantic noise) would go unnoticed
if (useSemantic) report("hybrid (+bm25+semantic)", hybrid, b, 0, bm25only);

// compare local models on the hard slices (paraphrase needles + cross-format
// docs) before ever changing the default model
const hardTypes = new Set(["needle", "needle-lexical", "cross-format", "doc-format"]);
for (const model of compareModels) {
  const prevModel = process.env.CONTEXT_MODEL;
  process.env.CONTEXT_MODEL = model;
  const m = await runTasks(corpus, b, true, true);
  console.log(`\n[model ${model}]`);
  for (const [type, st] of m.byType) {
    if (!hardTypes.has(type)) continue;
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    console.log(`  ${type.padEnd(13)} recall ${(mean(st.recall) * 100).toFixed(0).padStart(3)}%  mrr ${mean(st.mrr).toFixed(2).padStart(5)}`);
  }
  if (prevModel === undefined) delete process.env.CONTEXT_MODEL;
  else process.env.CONTEXT_MODEL = prevModel;
}

// ---- reproducibility artifacts: manifest, raw results, failure corpus ----

interface VariantRecord {
  name: string;
  tasks: PerTask[];
}

const variantRecords: VariantRecord[] = [
  { name: "baseline", tasks: base.perTask },
  { name: "hybrid", tasks: bm25only.perTask },
];
if (useSemantic) variantRecords.push({ name: "semantic", tasks: hybrid.perTask });

const manifest = {
  seed,
  size: sizeName,
  modules: size,
  real: useReal,
  semantic: useSemantic,
  cacheSchema: (await import("../src/cache")).CACHE_VERSION,
  version: pkg.version,
  env: { bun: process.version, platform: process.platform, arch: process.arch, date: new Date().toISOString() },
  budgets: BUDGETS[sizeName],
  corpus: { files: corpus.files.size, tasks: corpus.tasks.length, repos: useReal ? realRepos : [], docs: useReal ? realDocs : [] },
  tasks: corpus.tasks.map((t) => ({ id: t.id, type: t.type, source: t.source, query: t.query, expectedFiles: t.expectedFiles, topK: t.topK, changed: t.changed ?? [] })),
};
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify(variantRecords, null, 2));
const failures = variantRecords.flatMap((v) =>
  v.tasks.filter((t) => t.recall === 0).map((t) => ({
    variant: v.name,
    id: t.id,
    type: t.type,
    query: t.query,
    expectedFiles: t.expectedFiles,
    topFiles: t.topFiles.slice(0, 5),
  })),
);
await fs.writeFile(path.join(outDir, "failures.jsonl"), failures.map((f) => JSON.stringify(f)).join("\n") + (failures.length ? "\n" : ""));
console.log(`\nbench: artifacts -> ${outDir} (manifest.json, results.json, failures.jsonl, ${failures.length} confirmed misses preserved)`);
