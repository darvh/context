import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { rankSymbols } from "../src/query";
import { buildBm25Index } from "../src/bm25";

/**
 * Retrieval evaluation. Runs the golden task set (eval/tasks.json) twice — the
 * fixed baseline (graph + lexical, no BM25) and the hybrid (plus FTS5 BM25) —
 * and reports Recall@k, MRR, p50/p95 latency, index size, and cache hit rate.
 * Plan Phase 3/4: "retrieval changes can be compared against a fixed baseline."
 *
 *   bun run eval               # both variants
 *   bun run eval -- baseline   # graph+lexical only
 *   bun run eval -- hybrid     # + BM25
 */

const ROOT = path.join(import.meta.dir, "..");
const FIXTURES = path.join(ROOT, "spike", "fixtures");
const TASKS = JSON.parse(await fs.readFile(path.join(ROOT, "eval", "tasks.json"), "utf8")).tasks as {
  id: string;
  repo: string;
  query: string;
  type: string;
  topK: number;
  expectedFiles: string[];
  expectedSymbols: string[];
  changed: string[];
}[];

interface TaskResult {
  id: string;
  query: string;
  expectedFiles: string[];
  recallFiles: number;
  recallSymbols: number;
  mrr: number;
  topFiles: string[];
}

function percentiles(ms: number[]): { p50: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: p(0.5), p95: p(0.95) };
}

async function runTasks(hybrid: boolean): Promise<{ tasks: TaskResult[]; latencies: { cold: number[]; warm: number[] }; indexBytes: number; cacheHits: number; parsed: number }> {
  const tasks: TaskResult[] = [];
  const cold: number[] = [];
  const warm: number[] = [];
  let indexBytes = 0;
  let cacheHits = 0;
  let parsed = 0;

  for (const t of TASKS) {
    const repoDir = path.join(FIXTURES, t.repo);

    // cold: bust the cache entry so build truly parses
    const { cachePathFor } = await import("../src/cache");
    await fs.rm(cachePathFor(repoDir), { force: true });

    let t0 = performance.now();
    const b1 = await build(repoDir);
    const idx1 = hybrid && b1.graph.symbols.length ? buildBm25Index(b1.graph) : undefined;
    const hits1 = rankSymbols({ task: t.query, graph: b1.graph, changed: new Set(t.changed), explicitFiles: [], bm25: idx1 });
    cold.push(performance.now() - t0);

    // warm: second build should reparse nothing
    t0 = performance.now();
    const b2 = await build(repoDir);
    const idx2 = hybrid && b2.graph.symbols.length ? buildBm25Index(b2.graph) : undefined;
    const hits2 = rankSymbols({ task: t.query, graph: b2.graph, changed: new Set(t.changed), explicitFiles: [], bm25: idx2 });
    warm.push(performance.now() - t0);

    cacheHits += b2.reused;
    parsed += b2.parsed + b1.parsed;
    if (idx2) indexBytes = Math.max(indexBytes, idx2.sizeBytes);

    const topK = hits2.slice(0, t.topK);
    const topFiles = [...new Set(topK.map((h) => h.symbol.file))];
    const topNames = topK.map((h) => h.symbol.name);

    const hitFiles = t.expectedFiles.filter((f) => topFiles.includes(f));
    const hitSyms = t.expectedSymbols.filter((n) => topNames.includes(n));
    const rr = t.expectedFiles.reduce((best, f) => {
      const rank = topFiles.indexOf(f);
      return rank >= 0 && (best === 0 || rank < best) ? rank + 1 : best;
    }, 0);

    tasks.push({
      id: t.id,
      query: t.query,
      expectedFiles: t.expectedFiles,
      recallFiles: t.expectedFiles.length ? hitFiles.length / t.expectedFiles.length : 1,
      recallSymbols: t.expectedSymbols.length ? hitSyms.length / t.expectedSymbols.length : 1,
      mrr: rr ? 1 / rr : 0,
      topFiles,
    });
  }

  return { tasks, latencies: { cold, warm }, indexBytes, cacheHits, parsed };
}

function summarize(name: string, r: Awaited<ReturnType<typeof runTasks>>) {
  const n = r.tasks.length;
  const mean = (f: (x: TaskResult) => number) => r.tasks.reduce((s, t) => s + f(t), 0) / n;
  const { p50: c50, p95: c95 } = percentiles(r.latencies.cold);
  const { p50: w50, p95: w95 } = percentiles(r.latencies.warm);
  const recallFiles = r.tasks.filter((t) => t.recallFiles > 0).length;
  console.log(`\n[${name}]`);
  console.log(`  recall@5 files:  ${(mean((t) => t.recallFiles) * 100).toFixed(1)}%  (tasks with ≥1 relevant file in top-k: ${recallFiles}/${n})`);
  console.log(`  recall@5 symbols:${(mean((t) => t.recallSymbols) * 100).toFixed(1)}%`);
  console.log(`  mrr:             ${mean((t) => t.mrr).toFixed(3)}`);
  console.log(`  cold latency:    p50 ${c50.toFixed(0)}ms  p95 ${c95.toFixed(0)}ms`);
  console.log(`  warm latency:    p50 ${w50.toFixed(0)}ms  p95 ${w95.toFixed(0)}ms`);
  console.log(`  index size:      ${r.indexBytes} bytes (bm25)  cache hits ${r.cacheHits}/${r.cacheHits + r.parsed}`);
  const missed = r.tasks.filter((t) => t.recallFiles === 0);
  if (missed.length) {
    console.log(`  top-k misses:`);
    for (const m of missed) console.log(`    ${m.id} "${m.query}" expected ${m.expectedFiles.join(",")} got ${m.topFiles.slice(0, 3).join(",") || "(none)"}`);
  }
}

const variant = process.argv.slice(2)[0] ?? "both";
if (variant === "baseline") {
  summarize("baseline (graph+lexical)", await runTasks(false));
} else if (variant === "hybrid") {
  summarize("hybrid (graph+lexical+bm25)", await runTasks(true));
} else {
  const base = await runTasks(false);
  const hybrid = await runTasks(true);
  summarize("baseline (graph+lexical)", base);
  summarize("hybrid (graph+lexical+bm25)", hybrid);
}
