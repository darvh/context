import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { build } from "../src/build";
import { writeJson, readJson, hookStatePath, lastCapsulePath, repoKey, cachePathFor } from "../src/cache";
import { runHook } from "../src/hooks/user";

const GO = new URL("./fixtures/go", import.meta.url).pathname;
const TS = new URL("./fixtures/typescript", import.meta.url).pathname;

describe("cache concurrency safety", () => {
  test("concurrent atomic writes to the same file never corrupt it", async () => {
    const file = path.join(import.meta.dir, "..", "var", "concurrent-" + Date.now() + ".json");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeJson(file, { i, pad: "x".repeat(64 + i) }),
      ),
    );
    const out = await readJson<{ i: number; pad: string }>(file);
    expect(out).not.toBeNull();
    expect(out!.i).toBeGreaterThanOrEqual(0);
    // no leftover temp files
    const dir = path.dirname(file);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
    await fs.rm(file, { force: true });
  });

  test("no stale temp files accumulate across normal writes", async () => {
    const file = path.join(import.meta.dir, "..", "var", "nofrag-" + Date.now() + ".json");
    await writeJson(file, { a: 1 });
    const dir = path.dirname(file);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
    await fs.rm(file, { force: true });
  });
});

describe("cache failure is recoverable", () => {
  test("build still returns a capsule when the cache dir is unwritable", async () => {
    // point XDG_CACHE_HOME at a path whose parent is a plain file: mkdir fails
    const blocker = path.join(import.meta.dir, "..", "var", "blocker-" + Date.now());
    await fs.writeFile(blocker, "not a dir");
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = blocker;
    try {
      const b = await build(GO);
      expect(b.graph.symbols.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
      await fs.rm(blocker, { force: true });
    }
  });
});

describe("per-repo hook and capsule state", () => {
  test("non-repo cwd keys by that exact cwd; sibling dirs never collide", async () => {
    const a = path.join(tmpdir(), "ctx-norepo-" + Date.now() + "-a");
    const b = path.join(tmpdir(), "ctx-norepo-" + Date.now() + "-b");
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    try {
      // two non-repo dirs -> distinct keys, everywhere
      expect(repoKey(a)).not.toBe(repoKey(b));
      expect(cachePathFor(a)).toContain(repoKey(a));
      expect(lastCapsulePath(a)).toContain(repoKey(a));
      expect(hookStatePath(a)).toContain(repoKey(a));
      // building a non-repo dir walks exactly that dir -> key = cwd
      const bb = await build(a);
      expect(bb.root).toBe(a);
      expect(bb.repoRoot).toBe(a); // no git root found -> the cwd itself
    } finally {
      await fs.rm(a, { recursive: true, force: true });
      await fs.rm(b, { recursive: true, force: true });
    }
  });

  test("two repos sharing one agent account keep separate state", async () => {
    // real git repos so findRoot() resolves each hook to its own repo slot
    const repoA = path.join(import.meta.dir, "..", "var", "repoA-" + Date.now());
    const repoB = path.join(import.meta.dir, "..", "var", "repoB-" + Date.now());
    for (const [dst, src] of [[repoA, GO], [repoB, TS]] as const) {
      await fs.rm(dst, { recursive: true, force: true });
      await fs.cp(src, dst, { recursive: true });
      const p = Bun.spawn({ cmd: ["git", "init", "-q"], cwd: dst, stdout: "pipe", stderr: "pipe" });
      await p.exited;
    }
    try {
      const task = `where is session persistence wired? two-repo ${Date.now()}`;
      const [outA, outB] = await Promise.all([
        runHook(task, repoA, { exit: false }),
        runHook(task + "b", repoB, { exit: false }),
      ]);
      expect(outA.hookSpecificOutput?.additionalContext).toBeTruthy();
      expect(outB.hookSpecificOutput?.additionalContext).toBeTruthy();

      const a = await readJson<{ key: string }>(hookStatePath(repoA));
      const b = await readJson<{ key: string }>(hookStatePath(repoB));
      expect(a?.key).toBeTruthy();
      expect(b?.key).toBeTruthy();
      expect(a!.key).not.toBe(b!.key);
    } finally {
      await fs.rm(repoA, { recursive: true, force: true });
      await fs.rm(repoB, { recursive: true, force: true });
    }
  });

  test("last-capsule and hook-state slots differ per repo", async () => {
    expect(lastCapsulePath(GO)).not.toBe(lastCapsulePath(TS));
    expect(hookStatePath(GO)).not.toBe(hookStatePath(TS));
  });
});
