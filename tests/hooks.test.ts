import { describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { runHook } from "../src/hooks/user";
import { runEditHook, blastRadius, editedFilePath } from "../src/hooks/edit";
import { sessionOrientation } from "../src/hooks/session";
import { renderStatusline } from "../src/statusline";
import { readHookState } from "../src/hooks/state";
import { writeJson, readJson, lastCapsulePath, repoKey, cachePathFor, writeCache, loadCache, CACHE_VERSION, hookStatePath } from "../src/cache";
import type { CacheRecord } from "../src/cache";
import { projectSavings } from "../src/savings";
import type { Capsule } from "../src/assemble";
import type { BuildResult } from "../src/build";

const GO = new URL("./fixtures/go", import.meta.url).pathname;
const TS = new URL("./fixtures/typescript", import.meta.url).pathname;

async function tmpRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-hook-"));
  await fs.mkdir(path.join(dir, "internal", "session"), { recursive: true });
  await fs.mkdir(path.join(dir, "cmd"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "internal", "session", "store.go"),
    `package session

type Store struct{ data map[string]string }

func OpenStore(path string) (*Store, error) { return &Store{data: map[string]string{}}, nil }

func (s *Store) Get(key string) (string, error) { return s.data[key], nil }

func (s *Store) Set(key, value string) error { s.data[key] = value; return nil }
`,
  );
  await fs.writeFile(
    path.join(dir, "cmd", "main.go"),
    `package main

import "ctx.example/internal/session"

func main() {
	store, _ := session.OpenStore("db")
	_, _ = store.Get("k")
}
`,
  );
  return dir;
}

describe("user hook", () => {
  test("short prompts are skipped (no injection)", async () => {
    const out = await runHook("fix the bug", GO, { exit: false });
    expect(out).toEqual({});
  });

  test("pure-chat prompts are skipped before the build (repo-affinity gate)", async () => {
    // seed the cache so the affinity gate actually runs (not a cache miss pass-through)
    await runHook(`where is session persistence handled in this codebase? seed ${Date.now()}`, GO, { exit: false });
    const out = await runHook("please rewrite this commit message to be more concise and professional", GO, { exit: false });
    expect(out).toEqual({});
  });

  test("real task injects a capsule", async () => {
    // unique task: the hook dedups on (task, tree, changed) — a fixed task
    // would no-op on the second run after state was persisted
    const task = `where is session persistence handled in this codebase? run ${Date.now()}${Math.random()}`;
    const out = await runHook(task, GO, { exit: false });
    expect(out.hookSpecificOutput?.additionalContext).toBeTruthy();
    expect(out.hookSpecificOutput!.additionalContext).toContain("paths:");
  });

  test("session token-savings total accumulates per session id", async () => {
    const root = (await (await import("../src/scan")).findRoot(GO)) ?? GO;
    // hook state persists across test runs: start from a clean slate
    await fs.rm(hookStatePath(root), { force: true });

    await runHook(`where is session persistence stored? seed ${Date.now()}`, GO, { exit: false, sessionId: "s1" });
    const s1 = (await readHookState(root)).savings!;
    expect(s1.savedTokens).toBeGreaterThan(0);
    const once = (await readHookState(root)).sessions?.["s1"] ?? 0;
    expect(once).toBe(s1.savedTokens);

    // a second injection into the same session adds; another session stays apart
    await runHook(`who closes the session store? seed ${Date.now()}`, GO, { exit: false, sessionId: "s1" });
    await runHook(`how does the store test work? seed ${Date.now()}`, GO, { exit: false, sessionId: "s2" });
    const state = await readHookState(root);
    const s2 = state.savings!.savedTokens;
    expect(state.sessions?.["s1"]).toBe(once + s2);
    expect(state.sessions?.["s2"]).toBe(s2);
  });
});

describe("post-edit hook (blast radius)", () => {
  test("editedFilePath handles claude and codex shapes", () => {
    expect(editedFilePath({ tool_input: { file_path: "/abs/store.go" } }, "/repo")).toBe("/abs/store.go");
    expect(editedFilePath({ tool_input: { command: "*** Update File: internal/session/store.go" } }, "/repo")).toBe("/repo/internal/session/store.go");
    expect(editedFilePath({ tool_input: { command: "*** Add File: a/b.go" } }, "/repo")).toBe("/repo/a/b.go");
    expect(editedFilePath({ tool_input: {} }, "/repo")).toBeNull();
  });

  test("blastRadius lists cross-file dependents, capped", async () => {
    const { build } = await import("../src/build");
    const b: BuildResult = await build(GO);
    const br = blastRadius(b, "internal/session/store.go");
    expect(br).toContain("blast radius for store.go");
    expect(br).toContain("NewHandler");
    expect(br).toContain("TestStorePersistsAcrossRestart");
    expect(br).toContain("main");
    // no dependents -> silent
    expect(blastRadius(b, "cmd/migrate/migrate.go")).toBeNull();
  });

  test("runEditHook emits claude PostToolUse output and marks the graph dirty", async () => {
    const repo = await tmpRepo();
    const out = await runEditHook(
      { tool_input: { file_path: path.join(repo, "internal", "session", "store.go") }, cwd: repo },
      { exit: false },
    );
    expect(out.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput!.additionalContext).toContain("blast radius for store.go");
    expect(out.hookSpecificOutput!.additionalContext).toContain("main");
    const state = await readHookState(repo);
    expect(state.dirty).toBe(true);
    expect(state.lastFile).toBe("store.go");
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("runEditHook emits codex systemMessage shape; --text prints plain", async () => {
    const repo = await tmpRepo();
    const out = await runEditHook(
      { tool_input: { command: "*** Update File: internal/session/store.go" }, hook_event_name: "PostToolUse", cwd: repo },
      { exit: false },
    );
    expect(out.systemMessage).toContain("blast radius");
    expect(out.hookSpecificOutput).toBeUndefined();
    await fs.rm(repo, { recursive: true, force: true });
  });
});

describe("session orientation", () => {
  test("directive + repo overview from the graph", async () => {
    const repo = await tmpRepo();
    const text = await sessionOrientation(repo);
    expect(text).toContain("context observe");
    expect(text).toContain("repo overview");
    expect(text).toContain("internal/session");
    await fs.rm(repo, { recursive: true, force: true });
  });
});

describe("statusline", () => {
  test("not-built message before any hook has run", () => {
    const [line] = renderStatusline({}, 0, null);
    expect(line).toContain("not built");
  });

  test("graph size, freshness badge, session savings", () => {
    const state = {
      status: { symbols: 120, edges: 340, files: 40, treeHash: "abc", updatedAt: 0 },
      lastFile: "store.go",
      dirty: false,
      staleCount: 0,
    };
    const lines = renderStatusline(state, 2400, 42);
    expect(lines[0]).toContain("120 symbols");
    expect(lines[0]).toContain("✓ synced");
    expect(lines[0]).toContain("~2.4k tok saved");
    expect(lines[1]).toContain("store.go");
    expect(lines[1]).toContain("ctx 42%");
  });

  test("stale badge when the working tree moved", () => {
    const [line] = renderStatusline({ status: { symbols: 1, edges: 1, files: 1, treeHash: "t", updatedAt: 0 }, dirty: true, staleCount: 3, lastFile: undefined }, 0, null);
    expect(line).toContain("⚠ 3 stale");
  });
});

describe("cache helpers", () => {
  test("writeJson/readJson roundtrip; path helpers are deterministic", async () => {
    const file = path.join(import.meta.dir, "..", "var", "cache-helper-" + Date.now() + ".json");
    await writeJson(file, { a: 1, nested: { b: [1, 2] } });
    expect(await readJson<{ a: number; nested: { b: number[] } }>(file)).toEqual({ a: 1, nested: { b: [1, 2] } });
    expect(await readJson(file + ".nope")).toBeNull();
    await fs.rm(file, { recursive: true, force: true });

    expect(repoKey(GO)).toMatch(/^[0-9a-f]{12}$/);
    expect(cachePathFor(GO)).toContain(repoKey(GO));
    expect(lastCapsulePath(GO)).toContain(".cache/context");
    expect(lastCapsulePath(GO)).not.toBe(lastCapsulePath(TS));
  });

  test("writeCache/loadCache reject a stale version", async () => {
    const rec: CacheRecord = {
      version: "not-" + CACHE_VERSION,
      repoKey: repoKey(GO),
      manifest: {},
      files: [],
      graph: { symbols: [], edges: [], imports: [] },
      docs: [],
    };
    await writeCache(GO, rec);
    expect(await loadCache(GO)).toBeNull();
  });
});

describe("savings", () => {
  test("projectSavings baselines the whole pointed-at files", async () => {
    const { build } = await import("../src/build");
    const b: BuildResult = await build(GO);
    const bm25 = b.graph.symbols.length ? (await import("../src/bm25")).buildBm25Index(b.graph) : undefined;
    const hits = (await import("../src/query")).rankSymbols({
      task: "session persistence",
      graph: b.graph,
      changed: new Set(),
      explicitFiles: [],
      bm25,
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
    expect(s.spansRead).toBeGreaterThan(0);
  });
});
