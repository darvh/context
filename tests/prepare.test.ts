import { describe, expect, test } from "bun:test";
import { build } from "../src/build";
import { rankSymbols, explicitFilesFromTask } from "../src/query";
import { buildBm25Index } from "../src/bm25";
import { assemble } from "../src/assemble";
import { renderCapsule } from "../src/render";

const GO = new URL("./fixtures/go", import.meta.url).pathname;
const TS = new URL("./fixtures/typescript", import.meta.url).pathname;

async function prepare(root: string, task: string, budget = 1200) {
  const b = await build(root);
  const explicitFiles = explicitFilesFromTask(task, b.files);
  const bm25 = b.graph.symbols.length ? buildBm25Index(b.graph) : undefined;
  const hits = rankSymbols({ task, graph: b.graph, changed: new Set(), explicitFiles, bm25 });
  return { b, capsule: assemble({ task, build: b, hits, budgetTokens: budget }) };
}

describe("prepare capsule", () => {
  test("task-conditioned: session query surfaces store.go", async () => {
    const { capsule } = await prepare(GO, "where is session persistence handled?");
    const top = capsule.hits[0];
    expect(top.file).toBe("internal/session/store.go");
    const names = capsule.hits.map((h) => h.name);
    expect(names).toContain("OpenStore");
    expect(names.slice(0, 3)).toContain("OpenStore");
    expect(top.handle).toBe("src-01");
    expect(capsule.hits.some((h) => h.name === "TestStorePersistsAcrossRestart")).toBe(true);
    expect(capsule.next.length).toBeGreaterThan(0);
  });

  test("typescript: openStore ranks first", async () => {
    const { capsule } = await prepare(TS, "session persistence");
    expect(capsule.hits[0].name).toBe("openStore");
    expect(capsule.hits[0].file).toBe("src/session/store.ts");
  });

  test("explicit file reference is seeded", async () => {
    const { capsule } = await prepare(GO, "fix the bug in internal/session/store.go:18");
    expect(capsule.hits[0].file).toBe("internal/session/store.go");
    expect(capsule.hits[0].reason).toContain("explicit-file");
  });
  test("budget truncates and stays bounded", async () => {
    const { capsule } = await prepare(GO, "where is session persistence handled?", 150);
    expect(capsule.truncated).toBe(true);
    expect(capsule.tokensUsed).toBeLessThanOrEqual(150 + 120);
  });

  test("deterministic output", async () => {
    const a = await prepare(GO, "session store");
    const b = await prepare(GO, "session store");
    expect(renderCapsule(a.capsule)).toBe(renderCapsule(b.capsule));
  });

  test("empty repo answers explicitly", async () => {
    const { capsule } = await prepare(GO, "quantum decoherence detector");
    expect(capsule.hits).toHaveLength(0);
    expect(capsule.unresolvedTerms.length).toBeGreaterThan(0);
  });
});
