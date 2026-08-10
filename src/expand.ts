import { promises as fs } from "node:fs";
import path from "node:path";
import type { Capsule } from "./assemble";
import { lastCapsulePath, readJson } from "./cache";

const CONTEXT_LINES = 2;
const MAX_LINES = 200;

export interface Expanded {
  file: string;
  fromLine: number;
  toLine: number;
  lines: string[];
}

export async function expandFromCapsule(capsule: Capsule | null, handle: string): Promise<Expanded | null> {
  const hit = capsule?.hits.find((h) => h.handle === handle);
  if (!hit) return null;
  return expandFile(path.resolve(capsule!.root, hit.file), hit.line);
}

export async function expandFile(file: string, centerLine: number): Promise<Expanded | null> {
  try {
    const text = await fs.readFile(file, "utf8");
    const all = text.split("\n");
    let from = Math.max(0, centerLine - 1 - CONTEXT_LINES);
    let to = Math.min(all.length - 1, centerLine + 1 + CONTEXT_LINES - 1);
    if (to - from + 1 > MAX_LINES) to = from + MAX_LINES - 1;
    return { file, fromLine: from + 1, toLine: to + 1, lines: all.slice(from, to + 1) };
  } catch {
    return null;
  }
}

export function renderExpanded(e: Expanded): string {
  const width = String(e.toLine).length;
  const out: string[] = [];
  for (let i = 0; i < e.lines.length; i++) {
    const ln = e.fromLine + i;
    out.push(`${String(ln).padStart(width)} | ${e.lines[i]}`);
  }
  return out.join("\n") + "\n";
}

export async function resolveExpand(root: string, handle: string): Promise<Expanded | null> {
  // handle may be file:line or symbol name
  const loc = /^(.+):(\d+)$/.exec(handle);
  if (loc) {
    const p = path.resolve(root, loc[1]);
    return expandFile(p, Number(loc[2]));
  }
  const capsule = await readJson<Capsule>(lastCapsulePath());
  return expandFromCapsule(capsule, handle);
}
