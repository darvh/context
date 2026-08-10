import { promises as fs } from "node:fs";
import path from "node:path";
import { scan } from "./scan";
import { langFor } from "./lang";
import { extractFile } from "./extract";
import { resolveFacts } from "./resolve";
import { loadCache, writeCache, repoKey, CACHE_VERSION } from "./cache";
import type { FileFacts, Graph } from "./facts";

export interface BuildResult {
  root: string; // walked tree (scope)
  repoRoot: string; // enclosing repository root
  gitHead: string | null;
  treeHash: string;
  files: string[];
  manifest: Record<string, string>;
  fileFacts: Map<string, FileFacts>;
  graph: Graph;
  changed: Set<string>;
  parsed: number;
  reused: number;
  parseMs: number;
  refreshMs: number;
  totalMs: number;
  sourceCacheMiss: boolean;
}

const CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function build(cwd: string): Promise<BuildResult> {
  const t0 = performance.now();
  const s = await scan(cwd);
  const cached = await loadCache(s.tree);

  const manifest = s.manifest;
  const changed = new Set<string>();
  for (const k of Object.keys(manifest)) if (manifest[k] !== cached?.manifest[k]) changed.add(k);
  for (const k of Object.keys(cached?.manifest ?? {})) if (!(k in manifest)) changed.add(k);

  const toParse = s.files.filter((f) => changed.has(f) && langFor(f) && manifest[f]);

  const fileFacts = new Map<string, FileFacts>();
  if (cached) {
    for (const ff of cached.files) {
      if (manifest[ff.file] === ff.hash) fileFacts.set(ff.file, ff);
    }
  }

  let parseMs = 0;
  if (toParse.length) {
    const t1 = performance.now();
    const results = await mapLimit(toParse, CONCURRENCY, async (f) => {
      const lang = langFor(f)!;
      const source = await fs.readFile(path.join(s.tree, f), "utf8");
      return extractFile(f, lang.name, source, manifest[f]);
    });
    for (const ff of results) fileFacts.set(ff.file, ff);
    parseMs = performance.now() - t1;
  }

  const t2 = performance.now();
  const graph = resolveFacts([...fileFacts.values()]);
  const resolveMs = performance.now() - t2;

  await writeCache(s.tree, {
    version: CACHE_VERSION,
    repoKey: repoKey(s.tree),
    manifest,
    files: [...fileFacts.values()],
    graph,
  });

  return {
    root: s.tree,
    repoRoot: s.root,
    gitHead: s.gitHead,
    treeHash: s.treeHash,
    files: s.files,
    manifest,
    fileFacts,
    graph,
    changed,
    parsed: toParse.length,
    reused: cached ? fileFacts.size - toParse.length : 0,
    parseMs,
    refreshMs: parseMs + resolveMs,
    totalMs: performance.now() - t0,
    sourceCacheMiss: !cached,
  };
}