import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildResult } from "../out/build";
import type { Capsule } from "../out/assemble";
import { estTokens } from "../core/tokens";

export interface Savings {
  coldTokens: number; // est. input tokens the agent would read/discover without the capsule
  capsuleTokens: number; // injected capsule tokens
  savedTokens: number; // cold - capsule
  savedPct: number; // saved / cold
  netTokens: number; // saved (tool-output overhead not observable from a hook)
  spansRead: number;
}

// Baseline = the whole files the capsule points at, not symbol bodies: a cold
// agent opens whole files (Read) to answer — it never reads the 40-line span
// we point at and stops. The baseline is the whole covered files, capped, so
// savedTokens stays positive on the normal case where the capsule is smaller
// than the files it replaces. Caps keep a giant file from inflating the
// number, and the union honest for a one-file answer.
const MAX_FILES = 4;
const PER_FILE_CAP_CHARS = 4000; // ≈1000 tokens per file
const TOTAL_CAP_CHARS = 12000; // ≈3000 tokens across the union

/**
 * Project input-token savings the capsule replaces: the whole files its hits
 * point at are what a cold agent would read through tool calls. Hook-observable
 * only — labeled `estimated` everywhere. Matches the plan's
 * `token_savings = cold_input - assisted_input`, with tool outputs not
 * observable from a hook (net is gross minus capsule only).
 */
export async function projectSavings(b: BuildResult, capsule: Capsule): Promise<Savings> {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const hit of capsule.hits) {
    if (files.length >= MAX_FILES) break;
    if (seen.has(hit.file)) continue;
    seen.add(hit.file);
    files.push(hit.file);
  }

  let chars = 0;
  let spansRead = 0;
  for (const f of files) {
    if (chars >= TOTAL_CAP_CHARS) break;
    try {
      const text = await fs.readFile(path.join(b.root, f), "utf8");
      const n = Math.min(text.length, PER_FILE_CAP_CHARS, TOTAL_CAP_CHARS - chars);
      if (n <= 0) continue;
      chars += n;
      spansRead++;
    } catch {
      // unreadable file: skip, the baseline still reflects what was counted
    }
  }

  const coldTokens = estTokens("x".repeat(chars));
  const capsuleTokens = capsule.tokensUsed;
  const savedTokens = Math.max(0, coldTokens - capsuleTokens);
  const savedPct = coldTokens > 0 ? (savedTokens / coldTokens) * 100 : 0;
  return {
    coldTokens,
    capsuleTokens,
    savedTokens,
    savedPct,
    netTokens: savedTokens,
    spansRead,
  };
}


