import { describe, expect, test } from "bun:test";
import { build } from "../src/out/build";
import { rankSymbols } from "../src/rank/query";
import { buildBm25Index } from "../src/rank/bm25";
import { assemble } from "../src/out/assemble";
import { expandFromCapsule, renderExpanded, resolveExpand, expandDocSection } from "../src/out/expand";
import { impact, renderImpact } from "../src/out/impact";
import { loadCache } from "../src/core/cache";
import { promises as fs } from "node:fs";
import path from "node:path";

const GO = new URL("./fixtures/go", import.meta.url).pathname;

async function prepareCapsule(root: string, task: string) {
  const b = await build(root);
  const bm25 = b.graph.symbols.length ? buildBm25Index(b.graph) : undefined;
  const hits = rankSymbols({ task, graph: b.graph, changed: new Set(), explicitFiles: [], bm25 });
  return assemble({ task, build: b, hits, budgetTokens: 1200 });
}

describe("expand", () => {
  test("returns raw source span for a handle", async () => {
    const capsule = await prepareCapsule(GO, "session persistence");
    const hit = capsule.hits.find((h) => h.name === "OpenStore")!;
    const e = await expandFromCapsule(capsule, hit.handle);
    expect(e).not.toBeNull();
    const out = renderExpanded(e!);
    expect(out).toContain("func OpenStore(path string)");
    expect(out).toContain("return &Store{");
  });

  test("accepts file:line directly", async () => {
    const e = await resolveExpand(GO, "internal/session/store.go:18");
    expect(e).not.toBeNull();
    expect(e!.lines.some((l) => l.includes("func OpenStore"))).toBe(true);
  });

  test("rejects file:line paths outside the requested root", async () => {
    const e = await resolveExpand(GO, "/etc/hosts:1");
    expect(e).toBeNull();
  });

  test("doc hits expand to the cached extracted section, not raw bytes", async () => {
    const root = path.join(import.meta.dir, "..", "spike", "fixtures", "go");
    // coordinates are EXTRACTED markdown lines, not original RTF bytes; the
    // converted doc has no source mapping, so line 1 selects the first section
    const e = await expandDocSection(root, "docs/archiver-policy.rtf", 1);
    expect(e).not.toBeNull();
    expect(e!.lines.join("\n")).toContain("cold storage"); // extracted markdown, not mojibake
    expect(e!.fromLine).toBe(1);
  });
});

describe("impact", () => {
  test("callers, tests, and diff for a symbol", async () => {
    const b = await build(GO);
    b.changed = new Set(["internal/session/store.go"]);
    const r = impact(b, "OpenStore");
    const callerFiles = r.callers.map((c) => c.file);
    expect(callerFiles).toContain("cmd/server/main.go");
    expect(callerFiles).toContain("internal/session/store_test.go");
    expect(r.tests.length).toBeGreaterThan(0);
    expect(r.changed).toBe(true);
    expect(renderImpact(r, false)).toContain("callers:");
  });

  test("--diff lists changed files", async () => {
    const b = await build(GO);
    b.changed = new Set(["cmd/server/main.go"]);
    const r = impact(b, undefined, true);
    expect(r.changedFiles).toContain("cmd/server/main.go");
    expect(renderImpact(r, true)).toContain("changed files");
  });

  test("unknown symbol fails softly", async () => {
    const b = await build(GO);
    const r = impact(b, "NoSuchSymbol");
    expect(r.symbol).toBeUndefined();
    expect(renderImpact(r, false)).toContain("symbol not found");
  });
});

describe("cache", () => {
  test("warm rebuild parses nothing; edit reparses one file", async () => {
    const root = path.join(import.meta.dir, "..", "var", "cache-test-" + Date.now());
    await fs.rm(root, { recursive: true, force: true });
    await fs.cp(GO, root, { recursive: true });

    const b1 = await build(root);
    expect(b1.parsed).toBeGreaterThan(0);

    const b2 = await build(root);
    expect(b2.parsed).toBe(0);
    expect(b2.reused).toBe(b1.parsed);

    const target = path.join(root, "internal", "session", "store.go");
    await fs.appendFile(target, "\n// touch\n");
    const b3 = await build(root);
    expect(b3.parsed).toBe(1);
    expect(b3.changed.has("internal/session/store.go")).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });

  test("cache is external to the repo", async () => {
    const rec = await loadCache(GO);
    expect(rec).not.toBeNull();
    expect(rec!.version).toMatch(/^context-cache-v\d+$/);
  });
});
