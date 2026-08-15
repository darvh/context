import { readFileSync } from "node:fs";
import { findRoot } from "./scan";
import { readHookState, type HookState } from "./hooks/state";

const C = {
  indigo: (s: string) => `\x1b[38;2;84;111;255m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;2;224;165;68m${s}\x1b[0m`,
  muted: (s: string) => `\x1b[38;5;244m${s}\x1b[0m`,
  text: (s: string) => `\x1b[38;5;251m${s}\x1b[0m`,
};
const SEP = C.muted(" · ");

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Live statusline (Claude Code `statusLine`/`subagentStatusLine`). Reads the
 *  hook-maintained cache only — a pure read, no subprocess, so it stays cheap
 *  even though the host calls it on every render. Mirrors graft's statusline:
 *  graph size + freshness + running session token savings. */
export function renderStatusline(
  state: Pick<HookState, "status" | "lastFile" | "dirty" | "staleCount">,
  sessionSaved: number,
  ctxPct: number | null,
): string[] {
  const status = state.status;
  if (!status) {
    return [C.muted("◤ context · not built · run ") + C.text('context observe "<task>"')];
  }
  const top = [
    C.muted("◤ ") + C.indigo("context"),
    C.text(`${status.symbols} symbols / ${status.edges} edges`),
    state.dirty ? C.amber(`⚠ ${state.staleCount ?? 1} stale`) : C.indigo("✓ synced"),
  ];
  if (sessionSaved > 0) top.push(C.indigo(`~${fmt(sessionSaved)} tok saved`));
  const bottom: string[] = [];
  if (typeof ctxPct === "number") bottom.push(C.text(`ctx ${ctxPct}%`));
  if (state.lastFile) bottom.push(C.muted("last: ") + C.text(state.lastFile));
  const lines = [top.join(SEP)];
  if (bottom.length) lines.push(C.muted("▸ ") + bottom.join(SEP));
  return lines;
}

export async function main(): Promise<void> {
  let input: any = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // no/invalid stdin: still render from the cwd
  }
  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const root = (await findRoot(cwd)) ?? cwd;
  const state = await readHookState(root);
  const sessionId = String(input.session_id || "default");
  const sessionSaved = state.sessions?.[sessionId] ?? 0;
  const agent = input?.agent?.name;
  if (agent) {
    process.stdout.write(`${C.muted("◤ ")}${C.indigo(agent)}${SEP}${C.muted("context")}\n`);
    return;
  }
  const raw = input?.context_window?.used_percentage;
  const ctxPct = typeof raw === "number" ? Math.round(raw) : null;
  process.stdout.write(renderStatusline(state, sessionSaved, ctxPct).join("\n") + "\n");
}
