import { describe, expect, test } from "bun:test";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runHook } from "../src/hooks/user";
import { runAgentHook } from "../src/hooks/agent";
import { writeJson, readJson, lastCapsulePath, repoKey, cachePathFor, writeCache, loadCache, CACHE_VERSION } from "../src/cache";
import type { CacheRecord } from "../src/cache";
import { projectSavings, formatSavings } from "../src/savings";
import type { Capsule } from "../src/assemble";
import type { BuildResult } from "../src/build";

const GO = new URL("./fixtures/go", import.meta.url).pathname;

describe("user hook", () => {
  test("short prompts are skipped (no injection)", async () => {
    const out = await runHook("fix the bug", GO, { exit: false });
    expect(out).toEqual({});
  });

  test("real task injects a capsule; agent hook reports savings", async () => {
    // unique task: the hook dedups on (task, tree, changed) — a fixed task
    // would no-op on the second run after state was persisted
    const task = `where is session persistence handled in this codebase? run ${Date.now()}${Math.random()}`;
    const out = await runHook(task, GO, { exit: false });
    expect(out.hookSpecificOutput?.additionalContext).toBeTruthy();
    expect(out.hookSpecificOutput!.additionalContext).toContain("paths:");

    const agentOut = await runAgentHook({ text: "ok done" }, { exit: false });
    expect(agentOut.savings).not.toBeNull();
    expect(agentOut.projection).toContain("context: savings");
    expect(agentOut.projection).toContain("estimated");
  });

  test("agent hook with provider usage appends raw counts", async () => {
    await runHook(`where is session persistence stored? seed ${Date.now()}`, GO, { exit: false });
    const out = await runAgentHook({ text: "x", usage: { input: 10, output: 5, total: 15 } }, { exit: false });
    expect(out.projection).toContain("provider input=10 output=5 total=15");
  });
});

describe("cache helpers", () => {
  test("writeJson/readJson roundtrip; path helpers are deterministic", async () => {
    const file = path.join(import.meta.dir, "..", "var", "cache-helper-" + Date.now() + ".json");
    await writeJson(file, { a: 1, nested: { b: [1, 2] } });
    expect(await readJson(file)).toEqual({ a: 1, nested: { b: [1, 2] } });
    expect(await readJson(file + ".nope")).toBeNull();
    await fs.rm(file, { recursive: true, force: true });

    expect(repoKey(GO)).toMatch(/^[0-9a-f]{12}$/);
    expect(cachePathFor(GO)).toContain(repoKey(GO));
    expect(lastCapsulePath()).toContain(".cache/context");
  });

  test("writeCache/loadCache reject a stale version", async () => {
    const rec: CacheRecord = {
      version: "not-" + CACHE_VERSION,
      repoKey: repoKey(GO),
      manifest: {},
      files: [],
      graph: { symbols: [], edges: [], imports: [] },
    };
    await writeCache(GO, rec);
    expect(await loadCache(GO)).toBeNull();
  });
});

describe("savings", () => {
  test("projectSavings counts cold spans; formatSavings is one line", async () => {
    const { build } = await import("../src/build");
    const b: BuildResult = await build(GO);
    const hits = (await import("../src/query")).rankSymbols({
      task: "session persistence",
      graph: b.graph,
      changed: new Set(),
      explicitFiles: [],
    });
    const capsule: Capsule = (await import("../src/assemble")).assemble({
      task: "session persistence",
      build: b,
      hits,
      budgetTokens: 1200,
    });
    const s = await projectSavings(b, capsule);
    expect(s.coldTokens).toBeGreaterThan(0);
    expect(s.capsuleTokens).toBeGreaterThan(0);
    expect(s.savedPct).toBeGreaterThanOrEqual(0);
    expect(formatSavings(s)).toContain("~");
  });
});
