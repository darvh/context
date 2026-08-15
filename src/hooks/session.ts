import { build } from "../build";
import { findRoot } from "../scan";
import { buildDirCards } from "../dirmap";
import { withTimeout } from "../async";
import { readHookState } from "./state";

/**
 * SessionStart orientation, graft-aligned: every session learns repository
 * discovery exists (even when skills are not auto-loaded), gets the
 * call-discipline that keeps the agent from over-tooling, a stale-graph
 * warning when the working tree moved since the last build, and a compact
 * repo overview from the (incremental) graph — a full repo map would burn the
 * context budget at every session start, so this stays a few hundred tokens
 * because the full command reference lives in the skill file. Plain-text
 * stdout works for both Claude Code and Codex SessionStart hooks. Fail open:
 * any build error or timeout degrades to the reminder alone.
 */
const SESSION_DIRECTIVE =
  "[context] This repo is indexed by context. Before non-trivial multi-file work, run `context observe \"<task>\"` once — it returns the task-relevant directories, files, and symbols with exact file:line. " +
  "Drill down with `context map <dir>` / `context follow <sym> <edge>` / `context impact <sym>` / `context expand <handle>`; most tasks need one call. " +
  "Already know the file? Skip it. Navigation only — read the source for evidence; don't re-run observe for the same task after edits.";

/** Working-tree drift warning, mirroring graft's stale banner. Reads only the
 *  hook-maintained state (no scan, no git): the post-edit hook recorded the
 *  dirty flag and changed-file count. */
function staleNote(state: { dirty?: boolean; staleCount?: number }): string | null {
  if (!state.dirty) return null;
  const n = state.staleCount ?? 1;
  return `⚠ context's graph is behind your working tree: ${n} changed file${n === 1 ? "" : "s"} unindexed. If observe/expand names a path that isn't there, don't chase it — run \`context observe\` to refresh the graph first.`;
}

const ORIENTATION_TIMEOUT_MS = 6000;
const TOP_DIRS = 6;

export async function sessionOrientation(cwd: string): Promise<string> {
  try {
    const root = (await findRoot(cwd)) ?? cwd;
    const b = await withTimeout(ORIENTATION_TIMEOUT_MS, build(root), null);
    if (!b) return SESSION_DIRECTIVE;
    const state = await readHookState(root);
    const banner = staleNote(state);
    const dirs = [...buildDirCards(b).values()]
      .sort((a, z) => z.files - a.files || a.path.localeCompare(z.path))
      .slice(0, TOP_DIRS);
    const lines = banner ? [banner, SESSION_DIRECTIVE] : [SESSION_DIRECTIVE];
    if (dirs.length) {
      lines.push(`\nrepo overview (${b.graph.symbols.length} symbols · ${b.graph.edges.length} edges):`);
      for (const d of dirs) {
        lines.push(
          `  ${d.path}/  ${d.files} files · ${d.lang}${d.tests ? ` · ${d.tests} tests` : ""}${d.surface.length ? ` · public: ${d.surface.join(", ")}` : ""}`,
        );
      }
    }
    return lines.join("\n");
  } catch {
    return SESSION_DIRECTIVE;
  }
}
