import { build } from "../build";
import { findRoot } from "../scan";
import { buildDirCards } from "../dirmap";
import { withTimeout } from "../async";

/**
 * SessionStart orientation: every session learns repository discovery exists,
 * even when skills are not auto-loaded, and gets a compact repo overview built
 * from the (incremental) graph — a full repo map would burn the context budget
 * at every session start, so this stays a few hundred tokens
 * because the full command reference lives in the skill file. Plain-text
 * stdout works for both Claude Code and Codex SessionStart hooks. Fail open:
 * any build error or timeout degrades to the reminder alone.
 */
const SESSION_DIRECTIVE =
  "[context] Repository discovery is wired into this session: run `context observe \"<task>\"` once before non-trivial multi-file work. " +
  "It returns the task-relevant directories, files, and symbols with exact source spans. " +
  "Drill down with `context map <dir>`, `context follow <symbol> <edge>`, `context impact <symbol>`, `context expand <handle>`. " +
  "One call answers most tasks; don't re-run observe for the same task after edits — the index refreshes on demand. " +
  "Navigation only — read the source for evidence.";

const ORIENTATION_TIMEOUT_MS = 6000;
const TOP_DIRS = 6;

export async function sessionOrientation(cwd: string): Promise<string> {
  try {
    const root = (await findRoot(cwd)) ?? cwd;
    const b = await withTimeout(ORIENTATION_TIMEOUT_MS, build(root), null);
    if (!b) return SESSION_DIRECTIVE;
    const dirs = [...buildDirCards(b).values()]
      .sort((a, z) => z.files - a.files || a.path.localeCompare(z.path))
      .slice(0, TOP_DIRS);
    const lines = [SESSION_DIRECTIVE];
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
