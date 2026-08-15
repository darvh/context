import { promises as fs } from "node:fs";
import path from "node:path";
import { scan, type ScanOpts } from "./scan";
import { mapLimit, withTimeout } from "./async";
import { langFor, rgLangFor } from "./lang";
import { extractFile } from "./extract";
import { resolveFacts } from "./resolve";
import { loadCache, writeCache, repoKey, CACHE_VERSION, cachePathFor } from "./cache";
import { isDocFile, extractDoc, sha256Hex, MAX_DOC_BYTES, type DocFact } from "./doc";
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
  docs: DocFact[];
  changed: Set<string>;
  parsed: number;
  reused: number;
  parseMs: number;
  refreshMs: number;
  totalMs: number;
  sourceCacheMiss: boolean;
  docMs: number; // document extraction/conversion time
  cacheBytes: number; // on-disk cache record size
}

const CONCURRENCY = 8;
const PARSE_TIMEOUT_MS = 10_000;
const DOC_TIMEOUT_MS = 30_000;

export async function build(cwd: string, opts: ScanOpts = {}): Promise<BuildResult> {
  const t0 = performance.now();
  const s = await scan(cwd, opts);
  const cached = await loadCache(s.tree);

  const manifest = s.manifest;
  const changed = new Set<string>();
  for (const k of Object.keys(manifest)) if (manifest[k] !== cached?.manifest[k]) changed.add(k);
  for (const k of Object.keys(cached?.manifest ?? {})) if (!(k in manifest)) changed.add(k);

  const toParse = s.files.filter((f) => changed.has(f) && (langFor(f) || rgLangFor(f)) && manifest[f]);

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
      const lang = langFor(f);
      const rg = lang ? null : rgLangFor(f);
      const langName = lang?.name ?? rg ?? "rg";
      const source = await fs.readFile(path.join(s.tree, f), "utf8");
      // bounded parse: a slow file is skipped, never allowed to hang the command
      return withTimeout(PARSE_TIMEOUT_MS, extractFile(f, langName, source, manifest[f]), null);
    });
    for (const ff of results) if (ff) fileFacts.set(ff.file, ff);
    parseMs = performance.now() - t1;
  }

  const t2 = performance.now();
  const graph = resolveFacts([...fileFacts.values()]);
  const resolveMs = performance.now() - t2;

  // docs lane: non-code files -> extracted text for BM25/semantic indexing.
  // Reuse by CONTENT identity: (size, mtime) is only trusted when the content
  // hash matches too, so same-size or timestamp-preserving edits cannot leave
  // stale text. The manifest already hashes <=1MB files (free); larger docs
  // are hashed on demand, bounded by MAX_DOC_BYTES.
  const t3 = performance.now();
  const docs: DocFact[] = [];
  const cachedDocs = new Map((cached?.docs ?? []).map((d) => [d.file, d]));
  const docFiles = s.files.filter((f) => isDocFile(f));
  const freshDocs = await mapLimit(docFiles, CONCURRENCY, async (f) => {
    try {
      const abs = path.join(s.tree, f);
      const st = await fs.stat(abs);
      if (st.size > MAX_DOC_BYTES) return null;
      const prev = cachedDocs.get(f);
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        const known = manifest[f];
        const hash = known ?? sha256Hex(new Uint8Array(await fs.readFile(abs)));
        if (hash === prev.hash) return prev;
      }
      const bytes = new Uint8Array(await fs.readFile(abs));
      // bounded conversion: a stuck converter yields an empty doc, never a hang
      const d = await withTimeout(
        DOC_TIMEOUT_MS,
        extractDoc(f, bytes),
        { file: f, text: "", sections: [], hash: sha256Hex(bytes), size: bytes.byteLength, mtimeMs: 0 },
      );
      d.mtimeMs = st.mtimeMs;
      return d;
    } catch {
      return null;
    }
  });
  for (const d of freshDocs) if (d) docs.push(d);
  const docMs = performance.now() - t3;

  let cacheBytes = 0;
  try {
    await writeCache(s.tree, {
      version: CACHE_VERSION,
      repoKey: repoKey(s.tree),
      manifest,
      files: [...fileFacts.values()],
      graph,
      docs,
    });
    cacheBytes = (await fs.stat(cachePathFor(s.tree))).size;
  } catch {
    // cache unavailable is recoverable: discovery still returns a capsule
  }

  return {
    root: s.tree,
    repoRoot: s.root,
    gitHead: s.gitHead,
    treeHash: s.treeHash,
    files: s.files,
    manifest,
    fileFacts,
    graph,
    docs,
    changed,
    parsed: toParse.length,
    reused: cached ? fileFacts.size - toParse.length : 0,
    parseMs,
    refreshMs: parseMs + resolveMs,
    totalMs: performance.now() - t0,
    sourceCacheMiss: !cached,
    docMs,
    cacheBytes,
  };
}