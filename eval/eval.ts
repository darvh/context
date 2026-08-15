import { promises as fs } from "node:fs";
import path from "node:path";
import { rankSymbols, appendSemanticHits, explicitFilesFromTask, queryConfidence, rankFiles, fuseFileHits } from "../src/rank/query";
import { buildBm25Index } from "../src/rank/bm25";
import { repoKey } from "../src/core/cache";
import { semanticEnabled, semanticSearch } from "../src/rank/semantic";
import { assemble } from "../src/out/assemble";
import { capsuleToJson } from "../src/out/render";
import { estTokens } from "../src/core/tokens";
import type { RankedHit } from "../src/rank/query";

/**
 * Retrieval evaluation.
 *
 *  - eval/tasks.json      deterministic fixture subset (CI, no network)
 *  - eval/real-tasks.json pinned real-repo tasks (--real clones at fixed
 *    revisions into var/real-eval, runs those tasks plus the fixture subset)
 *
 * Every task records query type, acceptable top-k, expected files/symbols, and
 * WHY the answer is relevant. Reports per-task rows, not just aggregates, so a
 * retrieval change can be accepted or rejected on real-data evidence with no
 * unexplained regression on authoritative path/symbol/change queries.
 *
 *   bun run eval                      # baseline + hybrid on fixtures
 *   bun run eval -- real              # + pinned real repos
 *   bun run eval -- semantic          # + semantic fallback lane
 *   bun run eval -- --json out.json   # raw per-task results
 */

import { buildTaskDirs, loadAllTasks, measureRecall, buildPerRepo, type Task, type RepoBuild } from "./eval-shared";

const BUDGET_TOKENS = 1200;

const args = process.argv.slice(2);
const useReal = args.includes("--real") || args.includes("real");
const useSemantic = args.includes("--semantic") || (await semanticEnabled());
const jsonArg = args.indexOf("--json");
const jsonOut = jsonArg >= 0 ? args[jsonArg + 1] : null;

interface TaskResult {
  id: string;
  type: string;
  repo: string;
  query: string;
  why?: string;
  expectedFiles: string[];
  recallFiles: number;
  recallSymbols: number;
  mrr: number;
  topFiles: string[];
  evidenceRecall: number;
  unrelatedItems: number;
  stepsToEvidence: number;
  outputTokens: number;
  budgetViolation: boolean;
}

interface VariantResult {
  name: string;
  tasks: TaskResult[];
  cold: number[];
  warm: number[];
  indexBytes: number;
  cacheHits: number;
  parsed: number;
}

function percentiles(ms: number[]): { p50: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: p(0.5), p95: p(0.95) };
}

async function runVariant(name: string, tasks: Task[], builds: Map<string, RepoBuild>, hybrid: boolean, semantic: boolean): Promise<VariantResult> {
  const results: TaskResult[] = [];
  const cold: number[] = [];
  const warm: number[] = [];
  let indexBytes = 0;
  let cacheHits = 0;
  let parsed = 0;
  const bm25ByRepo = new Map<string, ReturnType<typeof buildBm25Index>>();

  for (const t of tasks) {
    const rb = builds.get(t.repo)!;
    const b2 = rb.warm;
    cold.push(rb.coldMs);
    warm.push(rb.warmMs);
    cacheHits += b2.reused;
    parsed += b2.parsed + rb.cold.parsed;

    let idx2 = bm25ByRepo.get(t.repo);
    if (hybrid && !idx2) {
      idx2 = buildBm25Index(b2.graph, b2.docs);
      bm25ByRepo.set(t.repo, idx2);
    }
    if (idx2) indexBytes = Math.max(indexBytes, idx2.sizeBytes);

    const changed = new Set(t.changed);
    let hits: RankedHit[] = rankSymbols({
      task: t.query,
      graph: b2.graph,
      changed,
      explicitFiles: explicitFilesFromTask(t.query, b2.files),
      bm25: idx2,
      docs: b2.docs,
    });
    // file-only lane fuses into the shipped pipeline: a file the query names
    // by basename (Makefile, LICENSE, schema.sql) surfaces as a file-level hit
    hits = fuseFileHits(hits, t.query, b2.graph, b2.files, b2.docs);
    let semanticDirs: { path: string; sim: number }[] | undefined;
    if (semantic && queryConfidence(hits) !== "strong") {
      const sem = await semanticSearch(b2.root, b2.graph, b2.docs, t.query, { repoKey: repoKey(b2.root) });
      if (sem) {
        if (sem.symbols.length) hits = appendSemanticHits(hits, sem.symbols, b2.graph, b2.docs, t.query);
        semanticDirs = sem.dirs;
      }
    }

    // budget compliance: the capsule must serialize within the declared budget
    const capsule = assemble({ task: t.query, build: b2, hits, budgetTokens: BUDGET_TOKENS, changed, semanticDirs });
    const outputTokens = estTokens(capsuleToJson(capsule));
    const budgetViolation = outputTokens > BUDGET_TOKENS;

    const m = measureRecall(hits, t);

    // exact-evidence recall: an expected range is covered when a top-k hit
    // spans it (hit.range carries the complete source span)
    const topK = hits.slice(0, t.topK);
    const evidence = (t as Task & { evidence?: [string, number, number][] }).evidence ?? [];
    const covered = evidence.filter(([file, sl, el]) =>
      topK.some((h) => h.symbol.file === file && h.symbol.span.sl <= sl && h.symbol.span.el >= el),
    );
    const evidenceRecall = evidence.length ? covered.length / evidence.length : 1;

    // unrelated items: capsule hits driven ONLY by the dirty lane (recent-
    // change as sole reason) and outside expectations — the pollution metric
    // (0 = clean). Topically-related changed-file hits are by design.
    const dirtyHits = capsule.hits.filter(
      (h) => t.changed.includes(h.file) && !t.expectedFiles.includes(h.file) && h.reason.length === 1 && h.reason[0] === "recent-change",
    ).length;
    // calls-to-evidence: rank position (1-based) of the first expected file
    const firstExpected = t.expectedFiles.find((f) => m.topFiles.includes(f));
    const stepsToEvidence = firstExpected ? m.topFiles.indexOf(firstExpected) + 1 : Infinity;

    results.push({
      id: t.id,
      type: t.type,
      repo: t.repo,
      query: t.query,
      why: t.why,
      expectedFiles: t.expectedFiles,
      recallFiles: m.recallFiles,
      recallSymbols: m.recallSymbols,
      mrr: m.mrr,
      topFiles: m.topFiles,
      evidenceRecall,
      unrelatedItems: dirtyHits,
      stepsToEvidence,
      outputTokens,
      budgetViolation,
    });
  }

  return { name, tasks: results, cold, warm, indexBytes, cacheHits, parsed };
}

/** File-only retrieval lane: ranks FILES (path + basename + aggregated symbol
 *  terms), not symbols. Ships answers the symbol lane cannot see — configs,
 *  Makefiles, LICENSE, schema.sql, entry points with no parseable symbols.
 *  Measured on recallFiles alone: the answer to a file query IS the file. */
async function runFileVariant(tasks: Task[], builds: Map<string, RepoBuild>): Promise<VariantResult> {
  const results: TaskResult[] = [];
  const cold: number[] = [];
  const warm: number[] = [];
  for (const t of tasks) {
    const rb = builds.get(t.repo)!;
    const b2 = rb.warm;
    cold.push(rb.coldMs);
    warm.push(rb.warmMs);
    const ranked = rankFiles(t.query, b2.graph, b2.files, b2.docs);
    const topK = ranked.slice(0, t.topK);
    const topFiles = topK.map((f) => f.file);
    const hitFiles = t.expectedFiles.filter((f) => topFiles.includes(f));
    const rr = t.expectedFiles.reduce((best, f) => {
      const rank = topFiles.indexOf(f);
      return rank >= 0 && (best === 0 || rank < best) ? rank + 1 : best;
    }, 0);
    const firstExpected = t.expectedFiles.find((f) => topFiles.includes(f));
    results.push({
      id: t.id,
      type: t.type,
      repo: t.repo,
      query: t.query,
      why: t.why,
      expectedFiles: t.expectedFiles,
      recallFiles: t.expectedFiles.length ? hitFiles.length / t.expectedFiles.length : 1,
      recallSymbols: 1,
      mrr: rr ? 1 / rr : 0,
      topFiles,
      evidenceRecall: 1,
      unrelatedItems: 0,
      stepsToEvidence: firstExpected ? topFiles.indexOf(firstExpected) + 1 : Infinity,
      outputTokens: 0,
      budgetViolation: false,
    });
  }
  return { name: "files (file-only)", tasks: results, cold, warm, indexBytes: 0, cacheHits: 0, parsed: 0 };
}

function summarize(v: VariantResult) {
  const n = v.tasks.length;
  const mean = (f: (x: TaskResult) => number) => v.tasks.reduce((s, t) => s + f(t), 0) / n;
  const { p50: c50, p95: c95 } = percentiles(v.cold);
  const { p50: w50, p95: w95 } = percentiles(v.warm);
  const recallFiles = v.tasks.filter((t) => t.recallFiles > 0).length;
  const budgetViolations = v.tasks.filter((t) => t.budgetViolation).length;
  console.log(`\n[${v.name}]`);
  console.log(`  recall@k files:   ${(mean((t) => t.recallFiles) * 100).toFixed(1)}%  (tasks with ≥1 relevant file in top-k: ${recallFiles}/${n})`);
  console.log(`  recall@k symbols: ${(mean((t) => t.recallSymbols) * 100).toFixed(1)}%`);
  console.log(`  evidence recall:  ${(mean((t) => t.evidenceRecall) * 100).toFixed(1)}%`);
  console.log(`  unrelated items:  ${v.tasks.reduce((s, t) => s + t.unrelatedItems, 0)}  (dirty-file hits outside expectations; 0 = clean)`);
  const steps = v.tasks.filter((t) => Number.isFinite(t.stepsToEvidence)).map((t) => t.stepsToEvidence);
  console.log(`  calls-to-evidence: ${steps.length ? (steps.reduce((s, x) => s + x, 0) / steps.length).toFixed(2) : "-"} avg rank of first expected file`);
  console.log(`  mrr:              ${mean((t) => t.mrr).toFixed(3)}`);
  console.log(`  serialized tokens: ${Math.round(mean((t) => t.outputTokens))} avg/task  budget ${BUDGET_TOKENS}  violations ${budgetViolations}/${n}`);
  console.log(`  cold latency:     p50 ${c50.toFixed(0)}ms  p95 ${c95.toFixed(0)}ms`);
  console.log(`  warm latency:     p50 ${w50.toFixed(0)}ms  p95 ${w95.toFixed(0)}ms`);
  console.log(`  index size:       ${v.indexBytes} bytes (bm25)  cache hits ${v.cacheHits}/${v.cacheHits + v.parsed}`);
  const report = (title: string, xs: TaskResult[], line: (m: TaskResult) => string) => {
    if (!xs.length) return;
    console.log(`  ${title}:`);
    for (const m of xs) console.log(`    ${line(m)}`);
  };
  report(
    "top-k misses",
    v.tasks.filter((t) => t.recallFiles === 0 && t.type !== "needle"),
    (m) => `${m.id} "${m.query}" expected ${m.expectedFiles.join(",")} got ${m.topFiles.slice(0, 3).join(",") || "(none)"}`,
  );
  report(
    "semantic-lane needles (ceiling tasks, not deterministic misses)",
    v.tasks.filter((t) => t.type === "needle"),
    (m) => `${m.id} "${m.query}" recall ${m.recallFiles > 0 ? "hit" : "miss (embedding model ceiling)"} got ${m.topFiles.slice(0, 2).join(",") || "(none)"}`,
  );
  if (budgetViolations) {
    console.log(`  budget violations:`);
    for (const t of v.tasks.filter((x) => x.budgetViolation)) console.log(`    ${t.id} "${t.query}" serialized ${t.outputTokens} > ${BUDGET_TOKENS}`);
    process.exitCode = 1;
  }
}

function perTask(variants: VariantResult[]) {
  const cols = variants.map((v) => ({ name: v.name, byId: new Map(v.tasks.map((t) => [t.id, t])) }));
  console.log(`\nper-task (recall files / mrr):`);
  console.log(`  ${"id".padEnd(26)} ${cols.map((c) => c.name.padEnd(34)).join("")} verdict`);
  let regressed = 0;
  for (const id of cols[0].byId.keys()) {
    const rows = cols.map((c) => c.byId.get(id));
    if (rows.some((r) => !r)) continue;
    const fmt = (r: TaskResult) => `${(r.recallFiles * 100).toFixed(0).padStart(3)}% / ${r.mrr.toFixed(2).padStart(5)} e${(r.evidenceRecall * 100).toFixed(0).padStart(3)}%  [${r.topFiles.slice(0, 2).join(", ")}]`;
    const verdict: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      if (cur.recallFiles < prev.recallFiles - 1e-9) verdict.push(`REG ${cols[i].name}`);
      else if (cur.mrr < prev.mrr - 0.01) verdict.push(`mrr${cols[i].name}`);
    }
    if (verdict.length) regressed++;
    console.log(`  ${id.padEnd(26)} ${rows.map((r) => fmt(r!).padEnd(34)).join("")} ${verdict.join(", ") || "ok"}`);
  }
  if (regressed) {
    console.log(`  ${regressed}/${cols[0].byId.size} tasks regressed across variants`);
    process.exitCode = 1;
  }
}

const allTasks = await loadAllTasks(useReal);
const taskDirs = await buildTaskDirs(allTasks, useReal);
// build each repo once (cold+warm), share across all variants
const builds = await buildPerRepo(taskDirs);

const variants: VariantResult[] = [];
const base = await runVariant("baseline (graph+lexical)", allTasks, builds, false, false);
variants.push(base);
summarize(base);
const hybrid = await runVariant("hybrid (graph+lexical+bm25)", allTasks, builds, true, false);
variants.push(hybrid);
summarize(hybrid);
if (useSemantic) {
  const sem = await runVariant("hybrid (+bm25+semantic)", allTasks, builds, true, true);
  variants.push(sem);
  summarize(sem);
}
perTask(variants);

// file-only lane: a separate retrieval for symbol-less answers, measured on
// file recall alone (the answer to a file query IS the file). Reported
// separately, not in the per-task variant comparison — it is a different
// retrieval mode, not a variant of the symbol lane.
const fileTasks = allTasks.filter((t) => t.type === "file");
if (fileTasks.length) {
  const fv = await runFileVariant(fileTasks, builds);
  const n = fv.tasks.length;
  const hits = fv.tasks.filter((t) => t.recallFiles > 0).length;
  const mean = (f: (t: TaskResult) => number) => fv.tasks.reduce((s, t) => s + f(t), 0) / n;
  console.log(`\n[${fv.name}]`);
  console.log(`  recall@k files:   ${(mean((t) => t.recallFiles) * 100).toFixed(1)}%  (tasks with the expected file in top-k: ${hits}/${n})`);
  for (const t of fv.tasks) {
    console.log(`    ${t.id.padEnd(24)} ${(t.recallFiles > 0 ? "hit" : "MISS").padStart(4)} rank ${t.stepsToEvidence === Infinity ? "-" : t.stepsToEvidence} "${t.query}" -> ${t.expectedFiles.join(",")}`);
  }
}

if (jsonOut) {
  const out = { seed: null as null | number, env: { bun: process.version, date: new Date().toISOString() }, real: useReal, variants: variants.map((v) => ({ name: v.name, tasks: v.tasks, cold: v.cold, warm: v.warm, indexBytes: v.indexBytes, cacheHits: v.cacheHits, parsed: v.parsed })) };
  await fs.mkdir(path.dirname(jsonOut), { recursive: true });
  await fs.writeFile(jsonOut, JSON.stringify(out, null, 2));
  console.log(`\nraw results -> ${jsonOut}`);
}
