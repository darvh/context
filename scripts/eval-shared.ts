import { promises as fs } from "node:fs";
import path from "node:path";

/** Shared eval corpus machinery: task shape, pinned-corpus loading, and
 *  real-repo cloning. Used by scripts/eval.ts (regression gate) and
 *  scripts/bench.ts (variant idea checker) so both measure the same corpus. */

export const ROOT = path.join(import.meta.dir, "..");
export const FIXTURES = path.join(ROOT, "spike", "fixtures");
export const REAL_OUT = path.join(ROOT, "var", "real-eval");

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

export async function loadFixtureTasks(): Promise<Task[]> {
  const raw = await fs.readFile(path.join(ROOT, "eval", "tasks.json"), "utf8");
  const j = JSON.parse(raw) as { tasks: Task[] };
  return j.tasks.map((t) => ({ ...t, fixture: true, why: t.why ?? "fixture task: regression gate on a known-shape repository" }));
}

export async function loadRealTasks(): Promise<Task[]> {
  const raw = await fs.readFile(path.join(ROOT, "eval", "real-tasks.json"), "utf8");
  const j = JSON.parse(raw) as { tasks: Task[]; repos: { name: string; url: string; revision: string }[] };
  return j.tasks;
}

export async function loadRealRepos(): Promise<{ name: string; url: string; revision: string }[]> {
  const raw = await fs.readFile(path.join(ROOT, "eval", "real-tasks.json"), "utf8");
  const j = JSON.parse(raw) as { repos: { name: string; url: string; revision: string }[] };
  return j.repos;
}

/** Clone pinned real repos into var/real-eval at fixed revisions (idempotent:
 *  reuses an existing clone whose HEAD matches). */
export async function cloneReal(needed: Set<string>): Promise<Map<string, string>> {
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
