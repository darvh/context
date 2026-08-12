import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Benchmark run registry + monitor.
 *
 * Every benchmark run (one harbor job per task/arm) registers here, heartbeats
 * while alive, and is stoppable by id. The watchdog (monitor-agent.ts) polls
 * this state and auto-kills runs that stall past a heartbeat window.
 *
 *   bun run benchmark/monitor.ts status            list all runs
 *   bun run benchmark/monitor.ts stop <id|all>     kill run(s) (process group)
 *   bun run benchmark/monitor.ts watch <id>        tail a run's output log
 */

export type RunStatus = "running" | "done" | "error" | "stopped";

export interface RunState {
  id: string; // arm-task
  task: string;
  arm: "cold" | "proof";
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  status: RunStatus;
  outputLog: string;
  jobsDir: string;
  note?: string;
}

const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
export const STATE_DIR = path.join(base, "context", "bench");
const RUNS_DIR = path.join(STATE_DIR, "runs");

function runFile(id: string): string {
  return path.join(RUNS_DIR, id + ".json");
}

// Per-run files: each run owns its state file, so concurrent writers (split
// children + watchdog) never race on shared state. loadState reads all files.
export async function loadState(): Promise<RunState[]> {
  const out: RunState[] = [];
  const entries = await fs.readdir(RUNS_DIR).catch(() => []);
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(RUNS_DIR, e), "utf8")) as RunState);
    } catch {}
  }
  return out;
}

async function saveRun(r: RunState): Promise<void> {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const tmp = runFile(r.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(r, null, 2));
  await fs.rename(tmp, runFile(r.id));
}

export async function register(r: Omit<RunState, "startedAt" | "lastHeartbeat" | "status">): Promise<void> {
  await saveRun({ ...r, startedAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(), status: "running" });
}

export async function heartbeat(id: string): Promise<void> {
  const r = (await loadState()).find((x) => x.id === id);
  if (!r) return;
  r.lastHeartbeat = new Date().toISOString();
  await saveRun(r);
}

export async function setStatus(id: string, status: RunStatus, note?: string): Promise<void> {
  const r = (await loadState()).find((x) => x.id === id);
  if (!r) return;
  r.status = status;
  if (note) r.note = note;
  await saveRun(r);
}

export function isAlive(r: RunState): boolean {
  try {
    process.kill(r.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopRun(id: string, all = false): Promise<string[]> {
  const runs = await loadState();
  const targets = all ? runs.filter((r) => r.status === "running") : runs.filter((r) => r.id === id);
  const stopped: string[] = [];
  for (const r of targets) {
    try {
      process.kill(-r.pid, "SIGKILL"); // process group (detached spawn)
    } catch {
      try {
        process.kill(r.pid, "SIGKILL");
      } catch {}
    }
    r.status = "stopped";
    await saveRun(r);
    stopped.push(r.id);
  }
  return stopped;
}

export function renderStatus(runs: RunState[]): string {
  const lines: string[] = [];
  lines.push(`${"id".padEnd(16)} ${"task".padEnd(20)} ${"arm".padEnd(6)} ${"status".padEnd(9)} ${"pid".padEnd(7)} ${"hb-ago".padEnd(8)} ${"started"}`);
  for (const r of runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))) {
    const hbAgo = Math.round((Date.now() - new Date(r.lastHeartbeat).getTime()) / 1000);
    const alive = r.status === "running" && isAlive(r);
    const st = alive ? r.status : r.status === "running" ? "dead" : r.status;
    lines.push(
      `${r.id.padEnd(16)} ${r.task.padEnd(20)} ${r.arm.padEnd(6)} ${st.padEnd(9)} ${String(r.pid).padEnd(7)} ${String(hbAgo + "s").padEnd(8)} ${r.startedAt.slice(11, 19)}`,
    );
  }
  return lines.join("\n");
}

// ---- CLI ----
if (import.meta.main) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  if (cmd === "status") {
    const runs = await loadState();
    console.log(renderStatus(runs));
    const running = runs.filter((r) => r.status === "running").length;
    console.log(`\n${running} running, ${runs.filter((r) => r.status === "done").length} done, ${runs.filter((r) => r.status === "error").length} error, ${runs.filter((r) => r.status === "stopped").length} stopped`);
  } else if (cmd === "stop") {
    if (arg === "all") {
      const stopped = await stopRun("", true);
      console.log("stopped:", stopped.join(", ") || "nothing running");
    } else if (arg) {
      const stopped = await stopRun(arg);
      console.log(stopped.length ? "stopped: " + stopped.join(",") : "no such run: " + arg);
    } else {
      console.error("usage: monitor.ts stop <id|all>");
    }
  } else if (cmd === "watch") {
    const runs = await loadState();
    const r = runs.find((x) => x.id === arg);
    if (!r) {
      console.error("no such run: " + arg);
      process.exit(1);
    }
    const p = Bun.spawn({ cmd: ["tail", "-f", r.outputLog], stdout: "inherit", stderr: "inherit" });
    await p.exited;
  } else {
    console.log(`usage: monitor.ts status | stop <id|all> | watch <id>\nstate: ${STATE_FILE}`);
  }
}
