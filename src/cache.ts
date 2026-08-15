import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { FileFacts, Graph } from "./facts";
import type { DocFact } from "./doc";

// Bump CACHE_VERSION whenever extraction/ranking schema semantics change so
// stale cached facts are ignored and rebuilt.
export const CACHE_VERSION = "context-cache-v7";

export interface CacheRecord {
  version: string;
  repoKey: string;
  manifest: Record<string, string>;
  files: FileFacts[];
  graph: Graph;
  docs: DocFact[];
}

export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(homedir(), ".cache");
  return path.join(base, "context");
}

/**
 * Scope identity for all cached state. Every cache/capsule/hook/semantic file
 * is keyed by the canonical path of the directory actually walked:
 *  - inside a git repo, hooks walk the whole repo -> key = repo root;
 *  - otherwise (a plain cwd, or `--root`), the walked path IS the cwd/root ->
 *    key = that exact path.
 * So two checkouts, two sibling non-repo dirs, or two agent accounts never
 * collide, and a non-repo directory never shares state with any other.
 */
export function repoKey(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
}

export function cachePathFor(root: string): string {
  return path.join(cacheDir(), `${repoKey(root)}.json`);
}

/** Per-repo capsule slot: `context expand` never reads another repo's capsule. */
export function lastCapsulePath(root: string): string {
  return path.join(cacheDir(), `last-capsule-${repoKey(root)}.json`);
}

/** Per-repo hook dedup/savings state: two repos sharing an agent account stay isolated. */
export function hookStatePath(root: string): string {
  return path.join(cacheDir(), `hook-state-${repoKey(root)}.json`);
}

/**
 * Atomic write with a unique temp filename. Concurrent runs never clobber each
 * other's temp file; rename is atomic so readers see whole content or none.
 */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function loadCache(root: string): Promise<CacheRecord | null> {
  try {
    const raw = await fs.readFile(cachePathFor(root), "utf8");
    const rec = JSON.parse(raw) as CacheRecord;
    if (rec.version !== CACHE_VERSION || rec.repoKey !== repoKey(root)) return null;
    return rec;
  } catch {
    return null;
  }
}

export async function writeCache(root: string, rec: CacheRecord): Promise<void> {
  await atomicWrite(cachePathFor(root), JSON.stringify(rec));
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(data, null, 2));
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
