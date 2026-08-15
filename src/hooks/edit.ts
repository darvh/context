import path from "node:path";
import { basename, isAbsolute } from "node:path";
import { build, type BuildResult } from "../build";
import { findRoot } from "../scan";
import { changedFiles } from "../diff";
import { readHookState, writeHookState } from "./state";

export interface EditInput {
  tool_input?: { file_path?: string; command?: string };
  tool_name?: string;
  hook_event_name?: string;
  cwd?: string;
}

export interface EditOut {
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
}

/**
 * The absolute path of the file a PostToolUse edit touched, across host
 * edit-tool shapes:
 *   - Claude Code (Write/Edit/MultiEdit) states it directly as
 *     `tool_input.file_path` (already absolute).
 *   - Codex (apply_patch) carries the whole patch in `tool_input.command` and
 *     names the file in the patch header (`*** Add File:` / `*** Update File:`),
 *     as a repo-relative path — resolved against `root` here.
 * Returns null when neither shape yields a path, so the hook stays a no-op.
 */
export function editedFilePath(input: EditInput, root: string): string | null {
  const direct = input?.tool_input?.file_path;
  if (typeof direct === "string" && direct.trim()) return direct;
  const cmd = input?.tool_input?.command;
  if (typeof cmd === "string" && cmd) {
    const m = /^\*\*\*\s+(?:Add|Update)\s+File:\s+(.+?)\s*$/m.exec(cmd);
    if (m) return isAbsolute(m[1]) ? m[1] : path.join(root, m[1]);
  }
  return null;
}

/**
 * Who depends on an edited file: symbols defined in it that other files
 * reference/call/test, grouped and capped. Purely structural (reads the
 * graph), never an LLM call. Returns null when the file defines nothing
 * anyone else uses — a clean no-op.
 */
export function blastRadius(b: BuildResult, relFile: string, cap = 8): string | null {
  const ids = new Set(b.graph.symbols.filter((s) => s.file === relFile).map((s) => s.id));
  if (!ids.size) return null;
  const byId = new Map(b.graph.symbols.map((s) => [s.id, s]));
  const unique = new Map<string, string>();
  for (const e of b.graph.edges) {
    if (!ids.has(e.to) || ids.has(e.from)) continue;
    const caller = byId.get(e.from);
    const label = caller ? `${caller.name} (${basename(caller.file)})` : e.name;
    unique.set(`${e.kind}:${label}`, `  • ${caller ? caller.name : e.name} via ${e.kind} (${basename(caller?.file ?? "")})`);
  }
  if (!unique.size) return null;
  const items = [...unique.values()].slice(0, cap);
  if (items.length < unique.size) items.push(`  … plus ${unique.size - items.length} more`);
  return `[context] dependents of ${basename(relFile)} — code that can break when you edit it:\n${items.join("\n")}`;
}

/**
 * PostToolUse edit hook: mark the graph dirty (drives the statusline's stale
 * badge), record the last-edited file, and emit the blast radius of the edit.
 * Fail-open — never blocks the agent, and a file with no dependents stays
 * silent. Claude Code reads `hookSpecificOutput.additionalContext` (injected
 * into the turn); Codex has no PostToolUse additionalContext, so it gets the
 * same text as a UI-warning `systemMessage`.
 */
export async function runEditHook(input: EditInput, opts: { exit?: boolean; text?: boolean } = {}): Promise<EditOut> {
  const exit = opts.exit ?? true;
  const out: EditOut = {};
  try {
    const root = (await findRoot(String(input.cwd ?? process.cwd()))) ?? String(input.cwd ?? process.cwd());
    const file = editedFilePath(input, root);
    if (file) {
      const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;
      if (!rel.startsWith(".context/") && !rel.startsWith(".git/")) {
        const b = await build(root);
        const changed = await changedFiles(root);
        const state = await readHookState(root);
        state.lastFile = basename(rel);
        state.dirty = true;
        state.staleCount = changed.size;
        await writeHookState(root, state).catch(() => {});
        const br = blastRadius(b, rel);
        if (br) {
          const isCodex = typeof input.hook_event_name === "string";
          if (isCodex) out.systemMessage = br;
          else out.hookSpecificOutput = { hookEventName: "PostToolUse", additionalContext: br };
        }
      }
    }
  } catch {
    // fail open: an edit that can't be indexed never blocks the agent
  }
  if (exit) {
    if (opts.text) {
      const txt = out.hookSpecificOutput?.additionalContext ?? out.systemMessage ?? "";
      if (txt) process.stdout.write(txt + "\n");
    } else {
      process.stdout.write(JSON.stringify(out));
    }
    process.exit(0);
  }
  return out;
}
