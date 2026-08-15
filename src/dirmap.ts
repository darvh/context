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

/** Repo-relative directory of a file (shared with the semantic dir records). */
export function dirOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i > 0 ? file.slice(0, i) : ".";
}

interface DirAgg {
  files: Set<string>;
  langs: Set<string>;
  surface: Set<string>;
  entries: Set<string>;
  tests: number;
}

function ensureDir(byDir: Map<string, DirAgg>, dir: string, file: string): DirAgg {
  let c = byDir.get(dir);
  if (!c) {
    c = { files: new Set(), langs: new Set(), surface: new Set(), entries: new Set(), tests: 0 };
    byDir.set(dir, c);
  }
  c.files.add(file);
  c.langs.add(file.split(".").pop() ?? "");
  return c;
}

export function buildDirCards(b: BuildResult): Map<string, DirCard> {
  const byDir = new Map<string, DirAgg>();
  for (const s of b.graph.symbols) {
    const c = ensureDir(byDir, dirOf(s.file), s.file);
    if (s.exported && s.kind !== "import" && s.kind !== "test") c.surface.add(s.name);
    if (s.kind === "entry") c.entries.add(s.file);
    if (s.test) c.tests++;
  }
  // docs never enter the symbol graph, so a docs-only directory would vanish
  // from the card map; count doc files so docs/ still surfaces
  for (const d of b.docs) {
    ensureDir(byDir, dirOf(d.file), d.file);
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
    const dir = dirOf(h.symbol.file);
    score.set(dir, (score.get(dir) ?? 0) + h.score);
  }
  const out: DirCard[] = [];
  const seen = new Set<string>();
  const sorted = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  fill(out, seen, sorted.map(([dir]) => cards.get(dir)).filter((c): c is DirCard => !!c), CARD_MAX);
  return out;
}

/** Dedupe + cap a candidate stream into the card list (shared by the affinity
 *  ranking and the semantic fusion). */
function fill(out: DirCard[], seen: Set<string>, xs: DirCard[], cap: number): void {
  for (const c of xs) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    out.push(c);
    if (out.length >= cap) return;
  }
}

export function renderDirCard(c: DirCard): string {
  const lines = [`  ${c.path}/  ${c.files} files · ${c.lang} · ${c.tests} tests`];
  if (c.surface.length) lines.push(`    public: ${c.surface.join(", ")}`);
  if (c.entryPoints.length) lines.push(`    entry: ${c.entryPoints.join(", ")}`);
  return lines.join("\n");
}

/** Fuse semantic directory candidates into the affinity ranking: semantic
 *  dirs lead (by sim), then the affinity remainder fills up to CARD_MAX. Only
 *  called when the confidence gate says the lexical pass was weak — a strong
 *  pass keeps the pure affinity order. Deterministic: ties break by path. */
export function mergeSemanticDirs(cards: Map<string, DirCard>, affinity: DirCard[], semDirs: { path: string; sim: number }[]): DirCard[] {
  const out: DirCard[] = [];
  const seen = new Set<string>();
  const sem = [...semDirs]
    .sort((a, b) => b.sim - a.sim || a.path.localeCompare(b.path))
    .map((d) => cards.get(d.path))
    .filter((c): c is DirCard => !!c);
  fill(out, seen, sem, CARD_MAX);
  fill(out, seen, affinity, CARD_MAX);
  return out;
}
