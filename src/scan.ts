import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".cache",
  ".DS_Store",
  "*.lock",
];

export interface ScanResult {
  root: string; // repository root (git identity, cache key)
  tree: string; // directory actually walked (scope)
  relRoot: string; // repo root relative to tree ("" when equal)
  files: string[]; // paths relative to tree, sorted
  gitHead: string | null;
  treeHash: string; // content fingerprint of the walked tree
  manifest: Manifest; // path -> sha256, only files we would parse
}

const MAX_FILE_BYTES = 1 << 20;

export function hashContent(buf: Uint8Array): string {
  return createHash("sha256").update(buf as unknown as Buffer).digest("hex");
}

export async function findRoot(start: string): Promise<string | null> {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    try {
      await fs.access(path.join(dir, ".git"));
      return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function loadIgnore(...roots: string[]): Promise<(p: string, isDir: boolean) => boolean> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);
  for (const root of roots) {
    try {
      const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
      ig.add(gi.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")));
    } catch {}
  }
  return (p, isDir) => ig.ignores(isDir ? p + "/" : p);
}

async function collectFiles(root: string, isIgnored: (p: string, d: boolean) => boolean): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    const dir = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnored(r, true)) continue;
        stack.push(r);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (isIgnored(r, false)) continue;
        out.push(r);
      }
    }
  }
  return out;
}

export async function sha256File(root: string, rel: string): Promise<string> {
  const buf = await fs.readFile(path.join(root, rel));
  return hashContent(new Uint8Array(buf));
}

export interface Manifest {
  [path: string]: string;
}

export async function buildManifest(root: string, files: string[]): Promise<Manifest> {
  const m: Manifest = {};
  for (const f of files) {
    try {
      const st = await fs.stat(path.join(root, f));
      if (st.size > MAX_FILE_BYTES) continue;
      m[f] = await sha256File(root, f);
    } catch {}
  }
  return m;
}

export function treeHashOf(manifest: Manifest): string {
  const h = createHash("sha256");
  for (const k of Object.keys(manifest).sort()) h.update(`${k}\0${manifest[k]}\0`);
  return h.digest("hex").slice(0, 12);
}

async function gitOut(root: string, args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

export async function scan(cwd: string): Promise<ScanResult> {
  const abs = path.resolve(cwd);
  const repoRoot = (await findRoot(abs)) ?? abs;
  const tree = abs;
  const isIgnored = await loadIgnore(repoRoot, abs);
  const files = await collectFiles(tree, isIgnored);
  const manifest = await buildManifest(tree, files);
  const gitHead = await gitOut(repoRoot, ["rev-parse", "--short", "HEAD"]);
  return {
    root: repoRoot,
    tree,
    relRoot: repoRoot === abs ? "" : path.relative(abs, repoRoot),
    files,
    gitHead,
    treeHash: treeHashOf(manifest),
    manifest,
  };
}
