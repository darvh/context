import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildResult } from "./build";
import type { Capsule, CapsuleHit } from "./assemble";
import { estTokens } from "./tokens";

export interface Savings {
  coldTokens: number; // est. input tokens the agent would read/discover without the capsule
  capsuleTokens: number; // injected capsule tokens
  savedTokens: number; // cold - capsule
  savedPct: number; // saved / cold
  netTokens: number; // saved (tool-output overhead not observable from a hook)
  spansRead: number;
}

const MAX_SPANS = 6;
const MAX_SPAN_LINES = 40;
const MAX_TOTAL_LINES = 200;

/**
 * Project input-token savings the capsule replaces: the source spans the
 * capsule points at are what a cold agent would read through tool calls.
 * Hook-observable only — labeled `estimated` everywhere. Matches the plan's
 * `token_savings = cold_input - assisted_input`, with tool outputs not
 * observable from a hook (net is gross minus capsule only).
 */
export async function projectSavings(b: BuildResult, capsule: Capsule): Promise<Savings> {
  const spanCache = new Map<string, string[]>();
  let cold = 0;
  let spansRead = 0;
  let totalLines = 0;

  for (const hit of capsule.hits.slice(0, MAX_SPANS)) {
    const sym = b.graph.symbols.find((s) => s.file === hit.file && s.nameLine === hit.line);
    if (!sym) continue;
    const lines = await fileLines(b.root, hit.file, spanCache);
    if (!lines) continue;
    const region = lines.slice(sym.span.sl - 1, Math.min(sym.span.el, sym.span.sl - 1 + MAX_SPAN_LINES));
    if (!region.length) continue;
    totalLines += region.length;
    if (totalLines > MAX_TOTAL_LINES) break;
    cold += estTokens(region.join("\n"));
    spansRead++;
  }

  const capsuleTokens = capsule.tokensUsed;
  const savedTokens = Math.max(0, cold - capsuleTokens);
  const savedPct = cold > 0 ? (savedTokens / cold) * 100 : 0;
  return {
    coldTokens: cold,
    capsuleTokens,
    savedTokens,
    savedPct,
    netTokens: savedTokens,
    spansRead,
  };
}

async function fileLines(root: string, file: string, cache: Map<string, string[]>): Promise<string[] | null> {
  if (cache.has(file)) return cache.get(file)!;
  try {
    const text = await fs.readFile(path.join(root, file), "utf8");
    const lines = text.split("\n");
    cache.set(file, lines);
    return lines;
  } catch {
    cache.set(file, []);
    return null;
  }
}

/** One-line Graft-style projection for a hook or status line. */
export function formatSavings(s: Savings): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `context: ~${k(s.savedTokens)} tokens saved (est. ${s.savedPct.toFixed(0)}% of ${k(s.coldTokens)} cold)`;
}


