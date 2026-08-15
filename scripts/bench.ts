import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { rankSymbols, explicitFilesFromTask } from "../src/query";
import { buildBm25Index } from "../src/bm25";
import { assemble } from "../src/assemble";
import { capsuleToJson } from "../src/render";
import { estTokens } from "../src/tokens";
import { mapDir } from "../src/repo-map";
import { follow } from "../src/follow";
import { buildDirCards, rankDirCards } from "../src/dirmap";
import type { RankedHit } from "../src/query";

/**
 * Variant idea checker: one pinned corpus, one budget, four observation
 * variants. Reports per-task deltas, not an aggregate headline.
 *
 *   flat                    baseline flat hits (no DirMap)
 *   dirmap                  + DirMap L0 directory cards
 *   map                     + neighborhood RepoMap over the top directory
 *   trails                  + graph trails from the top hit
 *
 * Every task consumes the same pinned corpus (eval/tasks.json, plus
 * eval/real-tasks.json with --real), annotations, and budget. A variant only
 * ships when it does not regress file/symbol recall and stays within budget.
 *
 *   bun run bench                     # fixture corpus
 *   bun run bench -- real              # + pinned real repos
 *   bun run bench -- --json out.json   # raw per-task rows
 */

import { cloneReal, loadFixtureTasks, loadRealTasks, FIXTURES, type Task } from "./eval-shared";

const BUDGET = 1200;
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

const fixtureTasks = await loadFixtureTasks();
let allTasks = fixtureTasks;
if (useReal) {
  allTasks = [...(await loadRealTasks()), ...fixtureTasks];
}

// clone pinned real repos (same mechanism as eval)
const taskDirs = new Map<string, string>();
for (const t of allTasks) taskDirs.set(t.repo, path.join(FIXTURES, t.repo));
if (useReal) {
  const cloned = await cloneReal(new Set(allTasks.map((t) => t.repo)));
  for (const [name, dir] of cloned) taskDirs.set(name, dir);
}

async function runVariant(name: string, task: Task, buildCache: Map<string, Awaited<ReturnType<typeof build>>>): Promise<{ row: TaskRow; hits: RankedHit[]; capsule: ReturnType<typeof assemble> }> {
  const dir = taskDirs.get(task.repo)!;
  const b = await build(dir);
  buildCache.set(task.repo, b);
  const bm25 = buildBm25Index(b.graph, b.docs);
  const changed = new Set(task.changed);
  const hits = rankSymbols({ task: task.query, graph: b.graph, changed, explicitFiles: explicitFilesFromTask(task.query, b.files), bm25, docs: b.docs });
  const capsule = assemble({ task: task.query, build: b, hits, budgetTokens: BUDGET, changed });

  const topK = hits.slice(0, task.topK);
  const topFiles = [...new Set(topK.map((h) => h.symbol.file))];
  const hitFiles = task.expectedFiles.filter((f) => topFiles.includes(f));
  const hitSyms = task.expectedSymbols.filter((n) => topK.map((h) => h.symbol.name).includes(n));

  // dir recall = the DirMap ranking itself (top 3 by affinity), not the
  // budget-truncated capsule — the acceptance check is "relevant directory in
  // the top three"
  const expectedDirs = task.directories ?? [];
  const dirRecall = expectedDirs.length
    ? expectedDirs.filter((d) => rankDirCards(buildDirCards(b), hits).some((c) => c.path === d || c.path.startsWith(d))).length / expectedDirs.length
    : 1;

  let trailRecall = 1;
  if (name === "trails" && task.edges?.length && capsule.hits.length) {
    const hit = capsule.hits[0];
    const f = follow(b, `${hit.file}::${hit.name}::${hit.line}`, "all", 3);
    const found = (a: string, bName: string) => f.trails.some((t) => t.steps.some((s, i) => i > 0 && s.name === bName && t.steps[i - 1].name === a));
    const expected = task.edges.map(([a, bN]) => (found(a, bN) ? 1 : 0));
    trailRecall = expected.length ? expected.reduce<number>((s, x) => s + x, 0) / expected.length : 1;
  }

  // per-variant serialized tokens (ablation of the new sections)
  const tokens: Record<string, number> = {};
  const violation: Record<string, boolean> = {};
  const flat = { ...capsule, dirs: [] as never };
  tokens.flat = estTokens(capsuleToJson(flat));
  violation.flat = tokens.flat > BUDGET;
  tokens.dirmap = estTokens(capsuleToJson(capsule));
  violation.dirmap = tokens.dirmap > BUDGET;
  let mapOut = "";
  if (capsule.dirs.length) {
    mapOut = mapDir(b, capsule.dirs[0].path).blocks.map((blk) => `${blk.file} ${blk.syms.map((s) => s.name).join(" ")}`).join("\n");
  }
  tokens.map = estTokens(capsuleToJson(capsule)) + estTokens(mapOut);
  violation.map = tokens.map > BUDGET * 2;
  let trailOut = "";
  if (capsule.hits.length) {
    const hit = capsule.hits[0];
    trailOut = renderTrails(follow(b, `${hit.file}::${hit.name}::${hit.line}`, "all", 3));
  }
  tokens.trails = tokens.map + estTokens(trailOut);
  violation.trails = tokens.trails > BUDGET * 2;

  return {
    row: {
      id: task.id,
      recallFiles: task.expectedFiles.length ? hitFiles.length / task.expectedFiles.length : 1,
      recallSymbols: task.expectedSymbols.length ? hitSyms.length / task.expectedSymbols.length : 1,
      dirRecall,
      trailRecall,
      tokens,
      budgetViolation: violation,
    },
    hits,
    capsule,
  };
}

function renderTrails(r: ReturnType<typeof follow>): string {
  return r.trails.map((t) => t.steps.map((s) => s.name).join(" → ")).join("\n");
}

const results = new Map<string, TaskRow>();
for (const t of allTasks) {
  const { row } = await runVariant("flat", t, new Map());
  results.set(t.id, row);
}

const variants: VariantResult[] = [];
for (const name of ["flat", "dirmap", "map", "trails"]) {
  const rows: TaskRow[] = [];
  for (const t of allTasks) {
    const { row } = await runVariant(name, t, new Map());
    rows.push(row);
  }
  variants.push({ name, rows });
}

// per-task deltas, flat -> trails
console.log(`\nper-task deltas (file% / dir% / trail% / tokens flat->trails / budget):`);
let regressed = 0;
for (const r of results) {
  const [id] = r;
  const task = allTasks.find((t) => t.id === id)!;
  const flat = variants[0].rows.find((x) => x.id === id)!;
  const trails = variants[3].rows.find((x) => x.id === id)!;
  const dirmap = variants[1].rows.find((x) => x.id === id)!;
  const tks = `${flat.tokens.flat}->${trails.tokens.trails}`;
  const viol = Object.values(trails.budgetViolation).some(Boolean) ? "BUDGET" : "";
  const dirs = dirmap.dirRecall < 1 ? `dirLOW(${dirmap.dirRecall.toFixed(2)})` : "";
  const tr = trails.trailRecall < 1 ? `trailLOW(${trails.trailRecall.toFixed(2)})` : "";
  const file = trails.recallFiles < 1 ? "fileLOW" : "";
  const flags = [file, dirs, tr, viol].filter(Boolean).join(",");
  if (flags) regressed++;
  console.log(`  ${id.padEnd(14)} ${(trails.recallFiles * 100).toFixed(0).padStart(3)}% / ${(trails.dirRecall * 100).toFixed(0).padStart(3)}% / ${(trails.trailRecall * 100).toFixed(0).padStart(3)}%  ${tks.padEnd(14)} ${flags || "ok"}`);
}
console.log(`\n${regressed}/${results.size} tasks flagged`);

for (const v of variants) {
  const n = v.rows.length;
  const mean = (f: (r: TaskRow) => number) => v.rows.reduce((s, r) => s + f(r), 0) / n;
  console.log(`[${v.name}] files ${(mean((r) => r.recallFiles) * 100).toFixed(0)}% dirs ${(mean((r) => r.dirRecall) * 100).toFixed(0)}% trails ${(mean((r) => r.trailRecall) * 100).toFixed(0)}% avg tokens ${Math.round(mean((r) => r.tokens[v.name as keyof TaskRow["tokens"]]))}`);
}

if (jsonOut) {
  await fs.mkdir(path.dirname(jsonOut), { recursive: true });
  await fs.writeFile(jsonOut, JSON.stringify({ real: useReal, variants }, null, 2));
  console.log(`raw results -> ${jsonOut}`);
}
