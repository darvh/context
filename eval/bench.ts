import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/out/build";
import { rankSymbols, explicitFilesFromTask } from "../src/rank/query";
import { buildBm25Index } from "../src/rank/bm25";
import { assemble, type Capsule } from "../src/out/assemble";
import { capsuleToJson } from "../src/out/render";
import { estTokens } from "../src/core/tokens";
import { mapDir } from "../src/graph/repo-map";
import { follow } from "../src/out/follow";
import { buildDirCards, rankDirCards } from "../src/graph/dirmap";
import type { RankedHit } from "../src/rank/query";

/**
 * Observation idea checker: one pinned corpus, one budget, four observation
 * variants. Each variant is a genuinely different observation of the SAME
 * retrieval: flat (no DirMap), dirmap (+ DirMap cards), map (+ RepoMap of the
 * top directory), trails (+ graph trails from the top hit). Retrieval is never
 * re-ranked by a variant — a variant only changes what the agent observes — so
 * file/dir recall is a SHARED gate, measured once from the common hits and
 * reported as the ship condition, never as per-variant "evidence".
 *
 * flat/dirmap are Observe capsule variants sharing one budget (BUDGET): a
 * variant ships only when recall does not regress AND the capsule stays within
 * budget. map and trails are follow-up CALLS (separate commands per the
 * Observe contract), measured against their own declared budgets
 * (MAP_BUDGET/TRAILS_BUDGET) and reported separately — the plan's "explicit
 * follow-up-call budgets" resolution, not a bigger Observe budget.
 *
 *   bun run bench                     # fixture corpus
 *   bun run bench -- real              # + pinned real repos
 *   bun run bench -- --json out.json   # raw per-task rows
 */

import { buildTaskDirs, loadAllTasks, type Task } from "./eval-shared";

const BUDGET = 1200;
const MAP_BUDGET = 400;
const TRAILS_BUDGET = 400;
const args = process.argv.slice(2);
const useReal = args.includes("--real") || args.includes("real");
const jsonArg = args.indexOf("--json");
const jsonOut = jsonArg >= 0 ? args[jsonArg + 1] : null;

interface TaskRow {
  id: string;
  recallFiles: number;
  recallSymbols: number;
  dirRecall: number;
  trailRecall: number;
  tokens: Record<string, number>;
  budgetViolation: Record<string, boolean>;
}

interface VariantResult {
  name: string;
  rows: TaskRow[];
}

const allTasks = await loadAllTasks(useReal);

// clone pinned real repos (same mechanism as eval)
const taskDirs = await buildTaskDirs(allTasks, useReal);

function flatCapsule(c: Capsule): Capsule {
  return { ...c, dirs: [] as Capsule["dirs"] };
}

/** Serialized observation per variant. flat/dirmap are Observe capsule
 *  variants (one BUDGET); map and trails are follow-up calls with their own
 *  declared budgets, reported separately — the plan's "separate operations"
 *  contract, measured as the op's own output, not an all-in-one sum.
 *  Computed once per task — the capsule, mapDir output, and trail graph are
 *  identical across variant names. */
function observationTokens(capsule: Capsule, b: Awaited<ReturnType<typeof build>>): { flat: number; dirmap: number; map: number; trails: number; trailGraph: ReturnType<typeof follow> | null } {
  const dirmap = estTokens(capsuleToJson(capsule));
  const flat = estTokens(capsuleToJson(flatCapsule(capsule)));
  let mapOut = "";
  if (capsule.dirs.length) {
    mapOut = mapDir(b, capsule.dirs[0].path).blocks.map((blk) => `${blk.file} ${blk.syms.map((s) => s.name).join(" ")}`).join("\n");
  }
  let trailOut = "";
  let trailGraph: ReturnType<typeof follow> | null = null;
  if (capsule.hits.length) {
    const hit = capsule.hits[0];
    trailGraph = follow(b, `${hit.file}::${hit.name}::${hit.line}`, "all", 3);
    trailOut = renderTrails(trailGraph);
  }
  return { flat, dirmap, map: estTokens(mapOut), trails: estTokens(trailOut), trailGraph };
}

async function runTask(task: Task, b: Awaited<ReturnType<typeof build>>, bm25: ReturnType<typeof buildBm25Index>, dirCards: ReturnType<typeof buildDirCards>): Promise<TaskRow> {
  const changed = new Set(task.changed);
  const hits: RankedHit[] = rankSymbols({ task: task.query, graph: b.graph, changed, explicitFiles: explicitFilesFromTask(task.query, b.files), bm25, docs: b.docs });
  const capsule = assemble({ task: task.query, build: b, hits, budgetTokens: BUDGET, changed });
  const obs = observationTokens(capsule, b);

  const topK = hits.slice(0, task.topK);
  const topFiles = [...new Set(topK.map((h) => h.symbol.file))];
  const hitFiles = task.expectedFiles.filter((f) => topFiles.includes(f));
  const hitSyms = task.expectedSymbols.filter((n) => topK.map((h) => h.symbol.name).includes(n));

  // dir recall = the DirMap ranking itself (top 3 by affinity), not the
  // budget-truncated capsule — the acceptance check is "relevant directory in
  // the top three"
  const expectedDirs = task.directories ?? [];
  const dirRecall = expectedDirs.length
    ? expectedDirs.filter((d) => rankDirCards(dirCards, hits).some((c) => c.path === d || c.path.startsWith(d))).length / expectedDirs.length
    : 1;

  let trailRecall = 1;
  if (task.edges?.length && capsule.hits.length && obs.trailGraph) {
    const f = obs.trailGraph;
    const found = (a: string, bName: string) => f.trails.some((t) => t.steps.some((s, i) => i > 0 && s.name === bName && t.steps[i - 1].name === a));
    const expected = task.edges.map(([a, bN]) => (found(a, bN) ? 1 : 0));
    trailRecall = expected.length ? expected.reduce<number>((s, x) => s + x, 0) / expected.length : 1;
  }

  const tokens: Record<string, number> = { flat: obs.flat, dirmap: obs.dirmap, map: obs.map, trails: obs.trails };
  const violation: Record<string, boolean> = {
    flat: obs.flat > BUDGET,
    dirmap: obs.dirmap > BUDGET,
    map: obs.map > MAP_BUDGET,
    trails: obs.trails > TRAILS_BUDGET,
  };

  return {
    id: task.id,
    recallFiles: task.expectedFiles.length ? hitFiles.length / task.expectedFiles.length : 1,
    recallSymbols: task.expectedSymbols.length ? hitSyms.length / task.expectedSymbols.length : 1,
    dirRecall,
    trailRecall,
    tokens,
    budgetViolation: violation,
  };
}

function renderTrails(r: ReturnType<typeof follow>): string {
  return r.trails.map((t) => t.steps.map((s) => s.name).join(" → ")).join("\n");
}

// build each corpus repo once; tasks sharing a repo reuse the build, the BM25
// index, and the DirMap cards
const builds = new Map<string, Awaited<ReturnType<typeof build>>>();
const bm25s = new Map<string, ReturnType<typeof buildBm25Index>>();
const dirCards = new Map<string, ReturnType<typeof buildDirCards>>();
for (const repo of taskDirs.keys()) {
  const b = await build(taskDirs.get(repo)!);
  builds.set(repo, b);
  bm25s.set(repo, buildBm25Index(b.graph, b.docs));
  dirCards.set(repo, buildDirCards(b));
}

const rows: TaskRow[] = [];
for (const t of allTasks) rows.push(await runTask(t, builds.get(t.repo)!, bm25s.get(t.repo)!, dirCards.get(t.repo)!));

console.log(`\nper-task (shared recall: files% / dir% / trail% — tokens flat/dirmap/map/trails — budget):`);
let regressed = 0;
for (const r of rows) {
  const file = r.recallFiles < 1 ? "fileLOW" : "";
  const dirs = r.dirRecall < 1 ? `dirLOW(${r.dirRecall.toFixed(2)})` : "";
  const tr = r.trailRecall < 1 ? `trailLOW(${r.trailRecall.toFixed(2)})` : "";
  const viol = Object.values(r.budgetViolation).some(Boolean) ? "BUDGET" : "";
  const flags = [file, dirs, tr, viol].filter(Boolean).join(",");
  if (flags) regressed++;
  const tks = `f:${r.tokens.flat} d:${r.tokens.dirmap} m:${r.tokens.map} t:${r.tokens.trails}`;
  console.log(`  ${r.id.padEnd(14)} ${(r.recallFiles * 100).toFixed(0).padStart(3)}% / ${(r.dirRecall * 100).toFixed(0).padStart(3)}% / ${(r.trailRecall * 100).toFixed(0).padStart(3)}%  ${tks.padEnd(40)} ${flags || "ok"}`);
}
console.log(`\n${regressed}/${rows.length} tasks flagged (shared recall is the ship gate; recall is identical across variants by design — variants only change the observation)`);

const byVariant: VariantResult[] = ["flat", "dirmap", "map", "trails"].map((name) => ({
  name,
  rows: rows.map((r) => ({ ...r, tokens: { [name]: r.tokens[name] }, budgetViolation: { [name]: r.budgetViolation[name] } })),
}));
for (const v of byVariant) {
  const n = v.rows.length;
  const mean = (f: (r: TaskRow) => number) => v.rows.reduce((s, r) => s + f(r), 0) / n;
  const over = v.rows.filter((r) => r.budgetViolation[v.name]).length;
  const cap = v.name === "map" ? MAP_BUDGET : v.name === "trails" ? TRAILS_BUDGET : BUDGET;
  console.log(`[${v.name}] avg ${Math.round(mean((r) => r.tokens[v.name as keyof TaskRow["tokens"]]))} tokens (budget ${cap})  over ${over}/${n}`);
}

if (jsonOut) {
  await fs.mkdir(path.dirname(jsonOut), { recursive: true });
  await fs.writeFile(jsonOut, JSON.stringify({ real: useReal, budget: BUDGET, rows }, null, 2));
  console.log(`raw results -> ${jsonOut}`);
}
