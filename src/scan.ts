import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { mapLimit } from "./async";

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

export interface ScanOpts {
  /** extra glob patterns to ignore, on top of .gitignore + defaults */
  ignore?: string[];
  /** skip reading .gitignore files (defaults still apply) */
  noGitignore?: boolean;
}

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

async function loadIgnore(opts: ScanOpts, ...roots: string[]): Promise<(p: string, d: boolean) => boolean> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);
  if (opts.ignore?.length) ig.add(opts.ignore);
  if (!opts.noGitignore) {
    for (const root of roots) {
      try {
        const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
        ig.add(gi.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")));
      } catch {}
      try {
        // git's own per-repo ignore file: honored like any .gitignore
        const info = await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf8");
        ig.add(info.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")));
      } catch {}
    }
  }
  return (p, isDir) => ig.ignores(isDir ? p + "/" : p);
}

interface IgnoreLayer {
  dir: string; // rel path of the dir owning this gitignore ("" = tree root)
  ig: ReturnType<typeof ignore>;
}

async function collectFiles(root: string, baseIgnored: (p: string, d: boolean) => boolean, opts: ScanOpts): Promise<string[]> {
  const out: string[] = [];
  const stack: { rel: string; layers: IgnoreLayer[] }[] = [{ rel: "", layers: [] }];
  // every directory (real or symlinked) is walked once by realpath, so a
  // directory reachable through both a real path and a symlink — or a link
  // cycle (a -> b -> a) — never yields duplicate paths or hangs
  const seenDirs = new Set<string>([await fs.realpath(root).catch(() => root)]);
  while (stack.length) {
    const { rel, layers } = stack.pop()!;
    const dir = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
    } catch {
      continue;
    }
    // nested .gitignore rules are scoped to this dir and its descendants
    let own = layers;
    if (!opts.noGitignore) {
      try {
        const rules = (await fs.readFile(path.join(dir, ".gitignore"), "utf8"))
          .split(/\r?\n/)
          .filter((l) => l.trim() && !l.trim().startsWith("#"));
        if (rules.length) own = [...layers, { dir: rel, ig: ignore().add(rules) }];
      } catch {}
    }
    const ignored = (p: string, isDir: boolean): boolean => {
      if (baseIgnored(p, isDir)) return true;
      for (const l of own) {
        const relP = l.dir ? p.slice(l.dir.length + 1) : p;
        if (l.ig.ignores(isDir ? relP + "/" : relP)) return true;
      }
      return false;
    };
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignored(r, true)) continue;
        const real = await fs.realpath(full).catch(() => full);
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);
        stack.push({ rel: r, layers: own });
      } else if (e.isSymbolicLink()) {
        // follow symlinks (stat, not lstat) so linked files/dirs are indexed
        try {
          const st = await fs.stat(full);
          if (st.isDirectory()) {
            if (ignored(r, true)) continue;
            const real = await fs.realpath(full);
            if (seenDirs.has(real)) continue;
            seenDirs.add(real);
            stack.push({ rel: r, layers: own });
          } else if (st.isFile()) {
            if (ignored(r, false)) continue;
            out.push(r);
          }
        } catch {}
      } else if (e.isFile()) {
        if (ignored(r, false)) continue;
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

const MANIFEST_CONCURRENCY = 16;

export async function buildManifest(root: string, files: string[]): Promise<Manifest> {
  const m: Manifest = {};
  const hashed = await mapLimit(files, MANIFEST_CONCURRENCY, async (f) => {
    try {
      const st = await fs.stat(path.join(root, f));
      if (st.size > MAX_FILE_BYTES) return null;
      return [f, await sha256File(root, f)] as const;
    } catch {
      return null;
    }
  });
  for (const r of hashed) if (r) m[r[0]] = r[1];
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

export async function scan(cwd: string, opts: ScanOpts = {}): Promise<ScanResult> {
  const abs = path.resolve(cwd);
  const repoRoot = (await findRoot(abs)) ?? abs;
  const tree = abs;
  const isIgnored = await loadIgnore(opts, repoRoot, abs);
  const files = await collectFiles(tree, isIgnored, opts);
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
