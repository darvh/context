import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { rankSymbols, appendSemanticHits, explicitFilesFromTask } from "../src/query";
import { buildBm25Index } from "../src/bm25";
import { repoKey } from "../src/cache";
import { semanticEnabled, semanticSearch } from "../src/semantic";
import { assemble } from "../src/assemble";
import { capsuleToJson } from "../src/render";
import { estTokens } from "../src/tokens";
import type { RankedHit } from "../src/query";

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

const BUDGET_TOKENS = 1200;

const ROOT = path.join(import.meta.dir, "..");
const FIXTURES = path.join(ROOT, "spike", "fixtures");
const REAL_OUT = path.join(ROOT, "var", "real-eval");
const args = process.argv.slice(2);
const useReal = args.includes("--real") || args.includes("real");
const useSemantic = args.includes("--semantic") || (await semanticEnabled());
const jsonArg = args.indexOf("--json");
const jsonOut = jsonArg >= 0 ? args[jsonArg + 1] : null;

interface Task {
  id: string;
  repo: string;
  query: string;
  type: string;
  topK: number;
  expectedFiles: string[];
  expectedSymbols: string[];
  changed: string[];
  why?: string;
  fixture?: boolean;
}

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

async function cloneReal(tasks: Task[]): Promise<string[]> {
  const need = [...new Set(tasks.map((t) => t.repo))];
  const repos = JSON.parse(await fs.readFile(path.join(ROOT, "eval", "real-tasks.json"), "utf8")).repos as {
    name: string;
    url: string;
    revision: string;
  }[];
  const cloned: string[] = [];
  for (const r of repos) {
    if (!need.includes(r.name)) continue;
    const dst = path.join(REAL_OUT, r.name);
    try {
      const st = await fs.stat(path.join(dst, ".git"));
      const p = Bun.spawn({ cmd: ["git", "-C", dst, "rev-parse", "HEAD"], stdout: "pipe", stderr: "pipe" });
      const head = (await new Response(p.stdout).text()).trim();
      if (st.isDirectory() && head === r.revision) {
        cloned.push(dst);
        continue;
      }
    } catch {}
    await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
    console.log(`eval: cloning ${r.name} @ ${r.revision}`);
    const p = Bun.spawn({
      cmd: ["git", "clone", "-q", "--no-checkout", r.url, dst],
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await p.exited) !== 0) {
      console.log(`eval: clone failed for ${r.name}; skipping its tasks`);
      continue;
    }
    const co = Bun.spawn({ cmd: ["git", "-C", dst, "checkout", "-q", r.revision], stdout: "pipe", stderr: "pipe" });
    if ((await co.exited) !== 0) {
      console.log(`eval: pinned revision ${r.revision} unavailable for ${r.name}; skipping`);
      continue;
    }
    cloned.push(dst);
  }
  return cloned;
}

async function runVariant(name: string, tasks: Task[], taskDirs: Map<string, string>, hybrid: boolean, semantic: boolean): Promise<VariantResult> {
  const results: TaskResult[] = [];
  const cold: number[] = [];
  const warm: number[] = [];
  let indexBytes = 0;
  let cacheHits = 0;
  let parsed = 0;

  for (const t of tasks) {
    const dir = taskDirs.get(t.repo)!;
    const { cachePathFor } = await import("../src/cache");
    await fs.rm(cachePathFor(dir), { force: true });

    let t0 = performance.now();
    const b1 = await build(dir);
    const idx1 = hybrid ? buildBm25Index(b1.graph, b1.docs) : undefined;
    cold.push(performance.now() - t0);

    t0 = performance.now();
    const b2 = await build(dir);
    const idx2 = hybrid ? buildBm25Index(b2.graph, b2.docs) : undefined;
    warm.push(performance.now() - t0);

    cacheHits += b2.reused;
    parsed += b2.parsed + b1.parsed;
    if (idx2) indexBytes = Math.max(indexBytes, idx2.sizeBytes);

    let hits: RankedHit[] = rankSymbols({
      task: t.query,
      graph: b2.graph,
      changed: new Set(t.changed),
      explicitFiles: explicitFilesFromTask(t.query, b2.files),
      bm25: idx2,
      docs: b2.docs,
    });
    const changed = new Set(t.changed);
    if (semantic) {
      const cap = assemble({ task: t.query, build: b2, hits, budgetTokens: BUDGET_TOKENS, changed });
      if (cap.unresolvedTerms.length > 0) {
        const sem = await semanticSearch(b2.root, b2.graph, b2.docs, t.query, { repoKey: repoKey(b2.root) });
        if (sem?.length) hits = appendSemanticHits(hits, sem, b2.graph, b2.docs);
      }
    }

    // budget compliance: the capsule must serialize within the declared budget
    const capsule = assemble({ task: t.query, build: b2, hits, budgetTokens: BUDGET_TOKENS, changed });
    const outputTokens = estTokens(capsuleToJson(capsule));
    const budgetViolation = outputTokens > BUDGET_TOKENS;

    const topK = hits.slice(0, t.topK);
    const topFiles = [...new Set(topK.map((h) => h.symbol.file))];
    const topNames = topK.map((h) => h.symbol.name);
    const hitFiles = t.expectedFiles.filter((f) => topFiles.includes(f));
    const hitSyms = t.expectedSymbols.filter((n) => topNames.includes(n));
    const rr = t.expectedFiles.reduce((best, f) => {
      const rank = topFiles.indexOf(f);
      return rank >= 0 && (best === 0 || rank < best) ? rank + 1 : best;
    }, 0);

    results.push({
      id: t.id,
      type: t.type,
      repo: t.repo,
      query: t.query,
      why: t.why,
      expectedFiles: t.expectedFiles,
      recallFiles: t.expectedFiles.length ? hitFiles.length / t.expectedFiles.length : 1,
      recallSymbols: t.expectedSymbols.length ? hitSyms.length / t.expectedSymbols.length : 1,
      mrr: rr ? 1 / rr : 0,
      topFiles,
      outputTokens,
      budgetViolation,
    });
  }

  return { name, tasks: results, cold, warm, indexBytes, cacheHits, parsed };
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
  console.log(`  mrr:              ${mean((t) => t.mrr).toFixed(3)}`);
  console.log(`  serialized tokens: ${Math.round(mean((t) => t.outputTokens))} avg/task  budget ${BUDGET_TOKENS}  violations ${budgetViolations}/${n}`);
  console.log(`  cold latency:     p50 ${c50.toFixed(0)}ms  p95 ${c95.toFixed(0)}ms`);
  console.log(`  warm latency:     p50 ${w50.toFixed(0)}ms  p95 ${w95.toFixed(0)}ms`);
  console.log(`  index size:       ${v.indexBytes} bytes (bm25)  cache hits ${v.cacheHits}/${v.cacheHits + v.parsed}`);
  const missed = v.tasks.filter((t) => t.recallFiles === 0);
  if (missed.length) {
    console.log(`  top-k misses:`);
    for (const m of missed) console.log(`    ${m.id} "${m.query}" expected ${m.expectedFiles.join(",")} got ${m.topFiles.slice(0, 3).join(",") || "(none)"}`);
  }
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
    const fmt = (r: TaskResult) => `${(r.recallFiles * 100).toFixed(0).padStart(3)}% / ${r.mrr.toFixed(2).padStart(5)}  [${r.topFiles.slice(0, 2).join(", ")}]`;
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

const fixtureTasks: Task[] = (JSON.parse(await fs.readFile(path.join(ROOT, "eval", "tasks.json"), "utf8")).tasks as Task[]).map((t) => ({
  ...t,
  fixture: true,
  why: t.why ?? "fixture task: regression gate on a known-shape repository",
}));

let allTasks = fixtureTasks;
if (useReal) {
  const realTasks: Task[] = JSON.parse(await fs.readFile(path.join(ROOT, "eval", "real-tasks.json"), "utf8")).tasks;
  allTasks = [...realTasks, ...fixtureTasks];
}

const taskDirs = new Map<string, string>();
for (const t of allTasks) {
  const src = t.fixture ? path.join(FIXTURES, t.repo) : path.join(REAL_OUT, t.repo);
  taskDirs.set(t.repo, src);
}
if (useReal) {
  const cloned = await cloneReal(allTasks);
  for (const c of cloned) taskDirs.set(path.basename(c), c);
}

const variants: VariantResult[] = [];
const base = await runVariant("baseline (graph+lexical)", allTasks, taskDirs, false, false);
variants.push(base);
summarize(base);
const hybrid = await runVariant("hybrid (graph+lexical+bm25)", allTasks, taskDirs, true, false);
variants.push(hybrid);
summarize(hybrid);
if (useSemantic) {
  const sem = await runVariant("hybrid (+bm25+semantic)", allTasks, taskDirs, true, true);
  variants.push(sem);
  summarize(sem);
}
perTask(variants);

if (jsonOut) {
  const out = { seed: null as null | number, env: { bun: process.version, date: new Date().toISOString() }, real: useReal, variants: variants.map((v) => ({ name: v.name, tasks: v.tasks, cold: v.cold, warm: v.warm, indexBytes: v.indexBytes, cacheHits: v.cacheHits, parsed: v.parsed })) };
  await fs.mkdir(path.dirname(jsonOut), { recursive: true });
  await fs.writeFile(jsonOut, JSON.stringify(out, null, 2));
  console.log(`\nraw results -> ${jsonOut}`);
}
