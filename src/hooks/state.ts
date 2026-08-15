import type { Savings } from "../out/savings";
import { hookStatePath, readJson, writeJson } from "../core/cache";

/** Graph-size snapshot written by the user hook after each build. */
interface StatusInfo {
  symbols: number;
  edges: number;
  files: number;
  treeHash: string;
  updatedAt: number;
}

/**
 * Shared hook state, keyed per repo (hookStatePath). Written by the user hook
 * (key/seen/savings/sessions/status) and the post-edit hook (lastFile/
 * dirty/staleCount), read by the statusline. All hooks read-modify-write so
 * one hook never clobbers another's fields.
 */
export interface HookState {
  key: string;
  seen?: { tree: string; items: string[] };
  savings?: Savings;
  /** per-session accumulated tokens saved, keyed by host session_id */
  sessions?: Record<string, number>;
  status?: StatusInfo;
  lastFile?: string; // basename of the last edited file (post-edit)
  dirty?: boolean; // working tree moved ahead of the last graph build
  staleCount?: number; // changed-file count at last check
}

export async function readHookState(root: string): Promise<HookState> {
  return (await readJson<HookState>(hookStatePath(root))) ?? { key: "" };
}

export async function writeHookState(root: string, s: HookState): Promise<void> {
  await writeJson(hookStatePath(root), s);
}
