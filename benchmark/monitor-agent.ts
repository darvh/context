import { loadState, isAlive, setStatus, stopRun } from "./monitor";

/**
 * Watchdog: polls the run registry and auto-stops runs that stall.
 * A run is stalled when it is marked running but its heartbeat is older than
 * the window AND its process group is dead or unresponsive.
 *
 *   bun run benchmark/monitor-agent.ts [--hb-window 600]
 */

const HB_WINDOW_S = Number(process.argv.find((a) => a.startsWith("--hb-window="))?.split("=")[1] ?? 600);
const POLL_S = Number(process.argv.find((a) => a.startsWith("--poll="))?.split("=")[1] ?? 30);

async function tick(): Promise<void> {
  const runs = await loadState();
  const now = Date.now();
  for (const r of runs) {
    if (r.status !== "running") continue;
    const hbAgo = (now - new Date(r.lastHeartbeat).getTime()) / 1000;
    if (hbAgo <= HB_WINDOW_S) continue;
    // stalled heartbeat: process dead = stale entry; process alive = hung
    const alive = isAlive(r);
    if (alive) {
      console.log(`[monitor] ${r.id} stalled (no heartbeat ${Math.round(hbAgo)}s, pid ${r.pid} alive) — killing`);
      await stopRun(r.id);
      await setStatus(r.id, "stopped", `stalled: no heartbeat ${Math.round(hbAgo)}s`);
    } else {
      console.log(`[monitor] ${r.id} process dead — marking error`);
      await setStatus(r.id, "error", "process exited without status update");
    }
  }
}

console.log(`[monitor] watchdog started (hb-window=${HB_WINDOW_S}s, poll=${POLL_S}s)`);
while (true) {
  await tick();
  await Bun.sleep(POLL_S * 1000);
}
