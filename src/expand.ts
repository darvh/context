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
  // span-backed: expand the recorded source range with bounded context
  const [sl, el] = hit.range.split("-").map(Number);
  const abs = path.resolve(capsule!.root, hit.file);
  if (sl && el) return expandSpan(abs, sl, el);
  return expandFile(abs, hit.line);
}

/** Expand a doc hit from the cached extracted Markdown (the section that
 *  matched), never by reading a binary PDF/DOCX as text. Fails open to the
 *  raw file read when the extracted record is unavailable. */
export async function expandDocSection(root: string, file: string, line: number): Promise<Expanded | null> {
  try {
    const { build } = await import("./build");
    const b = await build(root);
    const d = b.docs.find((x) => x.file === file);
    const sec = d?.sections.find((s) => line >= s.line && line <= s.endLine) ?? d?.sections.find((s) => s.line === line);
    if (d && sec) {
      return { file, fromLine: sec.line, toLine: sec.endLine, lines: sec.text.split("\n") };
    }
  } catch {}
  return expandFile(path.resolve(root, file), line);
}

async function expandSpan(file: string, startLine: number, endLine: number): Promise<Expanded | null> {
  try {
    const all = (await fs.readFile(file, "utf8")).split("\n");
    let from = Math.max(0, startLine - 1 - CONTEXT_LINES);
    let to = Math.min(all.length - 1, endLine + CONTEXT_LINES - 1);
    if (to - from + 1 > MAX_LINES) to = from + MAX_LINES - 1;
    return { file, fromLine: from + 1, toLine: to + 1, lines: all.slice(from, to + 1) };
  } catch {
    return null;
  }
}

async function expandFile(file: string, centerLine: number): Promise<Expanded | null> {
  return expandSpan(file, centerLine, centerLine);
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
    const base = path.resolve(root);
    const p = path.resolve(base, loc[1]);
    const rel = path.relative(base, p);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return expandFile(p, Number(loc[2]));
  }
  const capsule = await readJson<Capsule>(lastCapsulePath(root));
  const hit = capsule?.hits.find((h) => h.handle === handle);
  if (hit?.kind === "doc") return expandDocSection(capsule!.root, hit.file, hit.line);
  return expandFromCapsule(capsule, handle);
}
