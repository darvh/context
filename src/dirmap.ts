import type { BuildResult } from "./build";
import type { RankedHit } from "./query";

/** DirMap: Observe L0. Compact directory cards derived from the scan, symbols,
 *  edges, tests, and docs — no prose, no LLM. Ranked per task by aggregated
 *  hit score, so a directory appears because the task is about it, not merely
 *  because it contains many symbols. */

export interface DirCard {
  path: string; // repo-relative directory
  files: number;
  lang: string;
  surface: string[]; // exported public names (bounded)
  entryPoints: string[];
  tests: number;
}

const SURFACE_MAX = 3;
const CARD_MAX = 3;

export function buildDirCards(b: BuildResult): Map<string, DirCard> {
  const byDir = new Map<string, { files: Set<string>; langs: Set<string>; surface: Set<string>; entries: Set<string>; tests: number }>();
  for (const s of b.graph.symbols) {
    const i = s.file.lastIndexOf("/");
    const dir = i > 0 ? s.file.slice(0, i) : ".";
    let c = byDir.get(dir);
    if (!c) {
      c = { files: new Set(), langs: new Set(), surface: new Set(), entries: new Set(), tests: 0 };
      byDir.set(dir, c);
    }
    c.files.add(s.file);
    c.langs.add(s.file.split(".").pop() ?? "");
    if (s.exported && s.kind !== "import" && s.kind !== "test") c.surface.add(s.name);
    if (s.kind === "entry") c.entries.add(s.file);
    if (s.test) c.tests++;
  }
  const out = new Map<string, DirCard>();
  for (const [dir, c] of byDir) {
    if (c.files.size === 0) continue;
    out.set(dir, {
      path: dir,
      files: c.files.size,
      lang: [...c.langs].filter((l) => l.length <= 4).join("/") || "text",
      surface: [...c.surface].sort().slice(0, SURFACE_MAX),
      entryPoints: [...c.entries].sort().slice(0, 2),
      tests: c.tests,
    });
  }
  return out;
}

/** Top task-affine directories, ranked by aggregated hit score per directory.
 *  Empty when the task has no hits, so unrelated directories never appear. */
export function rankDirCards(cards: Map<string, DirCard>, hits: RankedHit[]): DirCard[] {
  const score = new Map<string, number>();
  for (const h of hits) {
    const i = h.symbol.file.lastIndexOf("/");
    const dir = i > 0 ? h.symbol.file.slice(0, i) : ".";
    score.set(dir, (score.get(dir) ?? 0) + h.score);
  }
  const out: DirCard[] = [];
  for (const [dir, s] of [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const c = cards.get(dir);
    if (c) out.push(c);
    if (out.length >= CARD_MAX) break;
  }
  return out;
}

export function renderDirCard(c: DirCard): string {
  const lines = [`  ${c.path}/  ${c.files} files · ${c.lang} · ${c.tests} tests`];
  if (c.surface.length) lines.push(`    public: ${c.surface.join(", ")}`);
  if (c.entryPoints.length) lines.push(`    entry: ${c.entryPoints.join(", ")}`);
  return lines.join("\n");
}
