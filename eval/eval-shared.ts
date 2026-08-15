import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/out/build";
import { cachePathFor } from "../src/core/cache";

/** Shared eval corpus machinery: task shape, pinned-corpus loading, and
 *  real-repo cloning. Used by eval/eval.ts (regression gate) and
 *  eval/bench.ts (variant idea checker) so both measure the same corpus. */

const ROOT = path.join(import.meta.dir, "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const REAL_OUT = path.join(ROOT, "var", "real-eval");

export interface Task {
  id: string;
  repo: string;
  query: string;
  type: string;
  topK: number;
  expectedFiles: string[];
  expectedSymbols: string[];
  changed: string[];
  directories?: string[];
  edges?: string[][];
  why?: string;
  fixture?: boolean;
}

async function loadFixtureTasks(): Promise<Task[]> {
  const raw = await fs.readFile(path.join(ROOT, "eval", "tasks.json"), "utf8");
  const j = JSON.parse(raw) as { tasks: Task[] };
  return j.tasks.map((t) => ({ ...t, fixture: true, why: t.why ?? "fixture task: regression gate on a known-shape repository" }));
}

async function loadRealTasks(): Promise<Task[]> {
  const raw = await fs.readFile(path.join(ROOT, "eval", "real-tasks.json"), "utf8");
  const j = JSON.parse(raw) as { tasks: Task[]; repos: { name: string; url: string; revision: string }[] };
  return j.tasks;
}

async function loadRealRepos(): Promise<{ name: string; url: string; revision: string }[]> {
  const raw = await fs.readFile(path.join(ROOT, "eval", "real-tasks.json"), "utf8");
  const j = JSON.parse(raw) as { repos: { name: string; url: string; revision: string }[] };
  return j.repos;
}

export async function loadAllTasks(useReal: boolean): Promise<Task[]> {
  const fixtures = await loadFixtureTasks();
  if (!useReal) return fixtures;
  return [...(await loadRealTasks()), ...fixtures];
}

/** Resolve each task's corpus dir (fixture or cloned real repo), cloning
 *  pinned real repos on demand. */
export async function buildTaskDirs(allTasks: Task[], useReal: boolean): Promise<Map<string, string>> {
  const taskDirs = new Map<string, string>();
  for (const t of allTasks) {
    const src = t.fixture ? path.join(FIXTURES, t.repo) : path.join(REAL_OUT, t.repo);
    taskDirs.set(t.repo, src);
  }
  if (useReal) {
    const cloned = await cloneReal(new Set(allTasks.map((t) => t.repo)));
    for (const [name, dir] of cloned) taskDirs.set(name, dir);
  }
  return taskDirs;
}

/** recall@k + MRR for a ranked hit list against a task's expectations.
 *  Shared by eval (regression gate) and the experiment scripts. */
export function measureRecall<T extends { symbol: { file: string; name: string } }>(
  ranked: T[],
  t: Task,
  topK = t.topK,
): { recallFiles: number; recallSymbols: number; mrr: number; topFiles: string[] } {
  const top = ranked.slice(0, topK);
  const topFiles = [...new Set(top.map((h) => h.symbol.file))];
  const hitFiles = t.expectedFiles.filter((f) => topFiles.includes(f));
  const hitSyms = t.expectedSymbols.filter((n) => top.map((h) => h.symbol.name).includes(n));
  const rr = t.expectedFiles.reduce((best, f) => {
    const rank = topFiles.indexOf(f);
    return rank >= 0 && (best === 0 || rank < best) ? rank + 1 : best;
  }, 0);
  return {
    recallFiles: t.expectedFiles.length ? hitFiles.length / t.expectedFiles.length : 1,
    recallSymbols: t.expectedSymbols.length ? hitSyms.length / t.expectedSymbols.length : 1,
    mrr: rr ? 1 / rr : 0,
    topFiles,
  };
}

export interface RepoBuild {
  dir: string;
  cold: Awaited<ReturnType<typeof build>>;
  warm: Awaited<ReturnType<typeof build>>;
  coldMs: number;
  warmMs: number;
}

/** Build each corpus repo once (cache deleted first, then cold+warm). Tasks
 *  sharing a repo reuse the build — the eval measures retrieval, not build
 *  repetition. All variants share the same builds: the build is
 *  variant-independent (baseline/hybrid/semantic differ only post-build). */
export async function buildPerRepo(taskDirs: Map<string, string>): Promise<Map<string, RepoBuild>> {
  const out = new Map<string, RepoBuild>();
  for (const repo of taskDirs.keys()) {
    const dir = taskDirs.get(repo)!;
    await fs.rm(cachePathFor(dir), { force: true });
    let t0 = performance.now();
    const cold = await build(dir);
    const coldMs = performance.now() - t0;
    t0 = performance.now();
    const warm = await build(dir);
    const warmMs = performance.now() - t0;
    out.set(repo, { dir, cold, warm, coldMs, warmMs });
  }
  return out;
}

/** Clone pinned real repos into var/real-eval at fixed revisions (idempotent:
 *  reuses an existing clone whose HEAD matches). */
async function cloneReal(needed: Set<string>): Promise<Map<string, string>> {
  const repos = await loadRealRepos();
  const taskDirs = new Map<string, string>();
  for (const r of repos) {
    if (!needed.has(r.name)) continue;
    const dst = path.join(REAL_OUT, r.name);
    try {
      const p = Bun.spawn({ cmd: ["git", "-C", dst, "rev-parse", "HEAD"], stdout: "pipe", stderr: "pipe" });
      const head = (await new Response(p.stdout).text()).trim();
      if (head === r.revision) {
        taskDirs.set(r.name, dst);
        continue;
      }
    } catch {}
    await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
    console.log(`eval: cloning ${r.name} @ ${r.revision}`);
    const cl = Bun.spawn({ cmd: ["git", "clone", "-q", "--no-checkout", r.url, dst], stdout: "pipe", stderr: "pipe" });
    if ((await cl.exited) !== 0) {
      console.log(`eval: clone failed for ${r.name}; skipping its tasks`);
      continue;
    }
    const co = Bun.spawn({ cmd: ["git", "-C", dst, "checkout", "-q", r.revision], stdout: "pipe", stderr: "pipe" });
    if ((await co.exited) === 0) taskDirs.set(r.name, dst);
  }
  return taskDirs;
}
