import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withTimeout } from "../core/async";
import { atomicWrite, cacheDir } from "../core/cache";
import { runtimeKind } from "../cli/version";
import type { DocFact } from "../core/doc";
import { dirOf } from "../graph/dirmap";
import type { Graph, Span } from "../core/facts";
import { meaningfulTerms } from "./query";

/**
 * Optional local semantic fallback (plan Phase 5). Explicitly opt-in via
 * CONTEXT_SEMANTIC=1 — never a silent network call during discovery.
 *
 * WHAT is embedded (the design question that matters):
 *  - one record per symbol: name + signature + doc + path + a BOUNDED body
 *    snippet (first MAX_SNIPPET_LINES of the symbol's span). The body carries
 *    the actual code semantics — undocumented functions like `process()` are
 *    useless from name+sig alone. This stays symbol-level; we never embed
 *    whole files ("not arbitrary large file chunks").
 *  - WHAT is cached on disk: the float32 embeddings only, keyed by
 *    (repo, model version) in `~/.cache/context/semantic/<repo>-<model>.bin`,
 *    so re-runs of low-confidence queries don't re-embed. Vectors are
 *    content-addressed (sha256 of the embedded text), so only symbols whose
 *    text actually changed get re-embedded — line shifts and untouched files
 *    are deltas of zero. Raw code text is never stored outside the repo.
 *  - WHAT is never done: no remote vector store, no hosted API, no embedding
 *    of arbitrary file chunks.
 *
 * Model: sentence-transformers/all-MiniLM-L6-v2 q8 (~23MB) — generic, runs on
 * a typical dev laptop; override with CONTEXT_MODEL for a code-tuned model.
 * Privacy: inference is local; the only network call is the one-time model
 * download from Hugging Face on first use. Failure: any error degrades to the
 * lexical/graph result (fail open).
 */

export const SEMANTIC_VERSION = "semantic-v5";

const DTYPE = "q8";
const POOLING = "mean";
const BATCH = 64;
const MAX_SNIPPET_LINES = 20;
const MAX_NEIGHBORS = 6;
const MIN_SIM = 0.2;
const EMBED_TIMEOUT_MS = 60_000; // per batch; expiry fails the lane, never hangs the command
// MiniLM is the default that works with zero config. Code-tuned models
// (e.g. Xenova/jina-embeddings-v2-base-code, dim 768) are gated on HF and
// need CONTEXT_MODEL + an HF_TOKEN to download; the QUERY_PREFIX table has
// their instruction prefix ready. Any load failure degrades to lexical.
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Env wins over config, config over default. Cached per process. */
let modelMemo: string | null = null;
export async function modelName(): Promise<string> {
  if (modelMemo) return modelMemo;
  const env = process.env.CONTEXT_MODEL;
  if (env) return (modelMemo = env);
  try {
    const { readConfig } = await import("../cli/config");
    const cfg = await readConfig();
    if (cfg.model) return (modelMemo = cfg.model);
  } catch {}
  return (modelMemo = DEFAULT_MODEL);
}

// retrieval-tuned models expect an instruction prefix on the QUERY (asymmetric
// query/document); without it they underperform. Document/texts are embedded
// bare. Only applies to models that specify one.
const QUERY_PREFIX: Record<string, string> = {
  "Xenova/bge-small-en-v1.5": "Represent this sentence for searching relevant passages: ",
  "Xenova/bge-base-en-v1.5": "Represent this sentence for searching relevant passages: ",
  "jinaai/jina-embeddings-v2-base-code": "Given a web search query, retrieve relevant passages that answer the query: ",
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": "Given a web search query, retrieve relevant passages that answer the query: ",
};

function queryFor(model: string, task: string): string {
  return (QUERY_PREFIX[model] ?? "") + task;
}

export async function semanticEnabled(): Promise<boolean> {
  const env = process.env.CONTEXT_SEMANTIC ?? "";
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  try {
    const { readConfig } = await import("../cli/config");
    return (await readConfig()).semantic === true;
  } catch {
    return false;
  }
}

async function modelHash(): Promise<string> {
  return createHash("sha256").update(`${await modelName()}\0${DTYPE}\0${POOLING}\0${SEMANTIC_VERSION}`).digest("hex").slice(0, 12);
}

type Pipe = (texts: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;

let pipeP: Promise<Pipe | null> | null = null;
let warnedUnavailable = false;
function loadPipeline(): Promise<Pipe | null> {
  if (!pipeP) {
    pipeP = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const p = await pipeline("feature-extraction", await modelName(), { dtype: DTYPE, device: "cpu" });
      return p as Pipe;
    })().catch((error) => {
      // Requested but unavailable must not look like "no results": say so once,
      // then stay fail-open. The compiled binary reports its runtime so a user
      // can tell a missing runtime library from an empty corpus.
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `context: semantic unavailable in the ${runtimeKind()} runtime (${reason}); using lexical retrieval`,
        );
      }
      return null;
    });
  }
  return pipeP;
}

export interface SemanticHit {
  id: string;
  sim: number;
}

export interface SemanticDirHit {
  path: string;
  sim: number;
}

export interface SemanticResult {
  symbols: SemanticHit[];
  dirs: SemanticDirHit[];
}

async function snippet(fileText: string, span: Span): Promise<string> {
  const ls = fileText.split("\n");
  const from = Math.max(0, span.sl - 1);
  const to = Math.min(ls.length, from + MAX_SNIPPET_LINES);
  return ls.slice(from, to).join(" ").slice(0, 400);
}

const HASH_BYTES = 16; // sha256 prefix per vector; content-addresses the store

async function storePath(repoKey: string): Promise<string> {
  return path.join(cacheDir(), "semantic", `${repoKey}-${await modelHash()}.bin`);
}

async function loadStore(file: string, dim: number): Promise<Map<string, Float32Array>> {
  const store = new Map<string, Float32Array>();
  const buf = await fs.readFile(file);
  if (buf.byteLength < 8) return store;
  const count = buf.readUInt32LE(0);
  const fileDim = buf.readUInt32LE(4);
  if (fileDim !== dim || buf.byteLength !== 8 + count * (HASH_BYTES + dim * 4)) return store;
  let off = 8;
  for (let i = 0; i < count; i++) {
    const hex = Buffer.from(buf.subarray(off, off + HASH_BYTES)).toString("hex");
    off += HASH_BYTES;
    const f = new Float32Array(buf.buffer, buf.byteOffset + off, dim);
    off += dim * 4;
    store.set(hex, f);
  }
  return store;
}

async function saveStore(file: string, store: Map<string, Float32Array>, dim: number): Promise<void> {
  const refs = [...store.keys()];
  const buf = Buffer.alloc(8 + refs.length * (HASH_BYTES + dim * 4));
  buf.writeUInt32LE(refs.length, 0);
  buf.writeUInt32LE(dim, 4);
  let off = 8;
  for (const hex of refs) {
    Buffer.from(hex, "hex").copy(buf, off);
    off += HASH_BYTES;
    const v = store.get(hex)!;
    new Float32Array(v.buffer, v.byteOffset, dim).forEach((x, j) => buf.writeFloatLE(x, off + j * 4));
    off += dim * 4;
  }
  await atomicWrite(file, buf);
}

/**
 * Embed only the symbols whose embedded text changed (content-addressed).
 * Returns vectors in `targets` order. Any load/save error degrades to
 * re-embedding everything (fail open).
 */
async function embedSymbols(
  p: Pipe,
  root: string,
  targets: { id: string; span?: Span; file: string; text: string }[],
  repoKey: string,
  dim: number,
): Promise<Float32Array[]> {
  const file = await storePath(repoKey);
  let store: Map<string, Float32Array>;
  try {
    store = await loadStore(file, dim);
  } catch {
    store = new Map();
  }

  const texts: string[] = [];
  const hashes: string[] = [];
  const fileCache = new Map<string, string>();
  const missing: { text: string; hash: string }[] = [];
  for (const t of targets) {
    let record = t.text;
    if (t.span) {
      let fileText = fileCache.get(t.file);
      if (fileText === undefined) {
        fileText = await fs.readFile(path.join(root, t.file), "utf8").catch(() => "");
        fileCache.set(t.file, fileText);
      }
      record = `${t.text} ${await snippet(fileText, t.span)}`;
    }
    const hash = createHash("sha256").update(record).digest("hex").slice(0, HASH_BYTES * 2);
    texts.push(record);
    hashes.push(hash);
    if (!store.has(hash)) missing.push({ text: record, hash });
  }

  // embed only the delta
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const v = await withTimeout(EMBED_TIMEOUT_MS, p(batch.map((m) => m.text), { pooling: POOLING, normalize: true }), null);
    if (!v) throw new Error("embedding batch timed out"); // -> semanticSearch catch -> fail open
    for (let j = 0; j < batch.length; j++) {
      store.set(batch[j].hash, v.data.slice(j * dim, (j + 1) * dim));
    }
  }

  // prune stale entries (referenced by the current snapshot only) and persist
  const live = new Set(hashes);
  for (const k of store.keys()) if (!live.has(k)) store.delete(k);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await saveStore(file, store, dim);
  } catch {}

  return hashes.map((h) => store.get(h)!);
}

/** Top symbols + docs + directories by cosine similarity to the task; null on
 *  failure (fail open). Directory records are aggregates (path + public
 *  surface + lang) so a weak lexical pass still finds the right neighborhood. */
export async function semanticSearch(
  root: string,
  graph: Graph,
  docs: DocFact[],
  task: string,
  opts: { repoKey: string },
): Promise<SemanticResult | null> {
  const p = await loadPipeline();
  if (!p) return null;
  try {
    const model = await modelName();
    // multi-query: the raw task phrasing plus its expanded keyword form.
    // Natural-language tasks and code tokens live in different regions of the
    // embedding space; averaging both query vectors retrieves both.
    const kw = meaningfulTerms(task).slice(0, 8).join(" ");
    const qTexts = kw && kw !== task.toLowerCase() ? [queryFor(model, task), queryFor(model, kw)] : [queryFor(model, task)];
    const qv = await p(qTexts, { pooling: POOLING, normalize: true });
    const dim = qv.dims[qv.dims.length - 1];
    const q = new Float32Array(dim);
    for (let i = 0; i < qv.data.length; i += dim) for (let j = 0; j < dim; j++) q[j] += qv.data[i + j];
    let nrm = 0;
    for (let j = 0; j < dim; j++) nrm += q[j] * q[j];
    nrm = Math.sqrt(nrm) || 1;
    for (let j = 0; j < dim; j++) q[j] /= nrm;
    // imports are structural, not semantic: excluded. Docs embed their whole
    // extracted text (isolated sections score below the sim floor).
    const byId = new Map(graph.symbols.map((s) => [s.id, s]));
    const neighbors = new Map<string, string[]>();
    const addNeighbor = (id: string, label: string) => {
      const list = neighbors.get(id) ?? [];
      if (!list.includes(label) && list.length < MAX_NEIGHBORS) list.push(label);
      neighbors.set(id, list);
    };
    for (const e of graph.edges) {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (from && to) {
        addNeighbor(from.id, `${e.kind} ${to.name}`);
        addNeighbor(to.id, `${e.kind}-by ${from.name}`);
      }
    }
    const symbolTargets = [
      ...graph.symbols
        .filter((s) => s.kind !== "import")
        .map((s) => ({
          id: s.id,
          span: s.span as Span,
          file: s.file,
          text: `${s.name} ${s.sig} ${s.doc} ${s.file} ${s.strings?.join(" ") ?? ""} ${(neighbors.get(s.id) ?? []).join(" ")}`,
        })),
      ...docs.map((d) => ({ id: `doc::${d.file}`, file: d.file, text: d.text })),
    ];
    const dirTargets = dirRecords(graph).map((d) => ({ id: `dir::${d.path}`, file: d.path, text: d.text }));
    const all = [...symbolTargets, ...dirTargets];
    const vecs = await embedSymbols(p, root, all, opts.repoKey, dim);
    const sims = vecs.map((v) => {
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += v[j] * q[j];
      return dot;
    });
    const ranked = all
      .map((t, i) => ({ id: t.id, sim: sims[i] }))
      .filter((h) => h.sim >= MIN_SIM)
      .sort((a, b) => b.sim - a.sim);
    const symbols: SemanticHit[] = ranked.filter((h) => !h.id.startsWith("dir::")).slice(0, 10).map((h) => ({ id: h.id, sim: h.sim }));
    const dirs: SemanticDirHit[] = ranked.filter((h) => h.id.startsWith("dir::")).slice(0, 3).map((h) => ({ path: h.id.slice(5), sim: h.sim }));
    const out: SemanticResult = { symbols, dirs };
    return out.symbols.length || out.dirs.length ? out : null;
  } catch {
    return null;
  }
}

/** Directory aggregate records for embedding: path + public surface + lang. */
function dirRecords(graph: Graph): { path: string; text: string }[] {
  const byDir = new Map<string, { surface: string[]; lang: string; entries: string[]; files: Set<string> }>();
  for (const s of graph.symbols) {
    if (s.kind === "import") continue;
    const dir = dirOf(s.file);
    const rec = byDir.get(dir) ?? { surface: [], lang: s.file.split(".").pop() ?? "", entries: [], files: new Set() };
    if (s.exported && rec.surface.length < 5) rec.surface.push(s.name);
    if (s.kind === "entry") rec.entries.push(s.file);
    rec.files.add(s.file);
    byDir.set(dir, rec);
  }
  return [...byDir.entries()]
    .map(([path, r]) => ({ path, text: `directory ${path} ${r.lang}: ${r.surface.join(", ")}` }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
