import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { FileFacts, Graph } from "./facts";

// Bump CACHE_VERSION whenever extraction/ranking schema semantics change so
// stale cached facts are ignored and rebuilt.
export const CACHE_VERSION = "context-cache-v2";

export interface CacheRecord {
  version: string;
  repoKey: string;
  manifest: Record<string, string>;
  files: FileFacts[];
  graph: Graph;
}

function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(homedir(), ".cache");
  return path.join(base, "context");
}

export function cachePathFor(root: string): string {
  const key = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  return path.join(cacheDir(), `${key}.json`);
}

export function repoKey(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
}

export function lastCapsulePath(): string {
  return path.join(cacheDir(), "last-capsule.json");
}

export function hookStatePath(): string {
  return path.join(cacheDir(), "hook-state.json");
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
  const dir = path.dirname(cachePathFor(root));
  await fs.mkdir(dir, { recursive: true });
  const tmp = cachePathFor(root) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(rec));
  await fs.rename(tmp, cachePathFor(root));
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
