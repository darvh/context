import { describe, expect, test } from "bun:test";
import { build } from "../src/build";
import { impact, renderImpact } from "../src/impact";
import { follow } from "../src/follow";
import { mapDir } from "../src/repo-map";
import { buildDirCards, rankDirCards } from "../src/dirmap";
import { rankSymbols } from "../src/query";

const GO = new URL("./fixtures/go", import.meta.url).pathname;

async function buildGo() {
  const b = await build(GO);
  b.changed = new Set();
  return b;
}

describe("DirMap", () => {
  test("cards aggregate files, public surface, entry points, tests", async () => {
    const cards = buildDirCards(await buildGo());
    const session = cards.get("internal/session")!;
    expect(session).toBeDefined();
    expect(session.files).toBeGreaterThan(0);
    expect(session.surface.length).toBeGreaterThan(0); // bounded: exported names, sorted
    expect(session.tests).toBeGreaterThan(0);
    const server = cards.get("cmd/server")!;
    expect(server.entryPoints).toContain("cmd/server/main.go");
  });

  test("ranked by task affinity, not symbol count", async () => {
    const b = await buildGo();
    const hits = rankSymbols({ task: "session persistence", graph: b.graph, changed: new Set(), explicitFiles: [], bm25: undefined, docs: [] });
    const top = rankDirCards(buildDirCards(b), hits);
    expect(top[0].path).toBe("internal/session");
  });

  test("no hits means no directories", async () => {
    const b = await buildGo();
    expect(rankDirCards(buildDirCards(b), [])).toHaveLength(0);
  });
});

describe("follow trails", () => {
  test("callers and callees appear as directed trails", async () => {
    const b = await buildGo();
    const r = follow(b, "OpenStore", "all");
    expect(r.symbol?.name).toBe("OpenStore");
    const names = r.trails.flatMap((t) => t.steps.map((s) => s.name));
    expect(names).toContain("main"); // caller
    expect(names).toContain("TestStorePersistsAcrossRestart"); // caller (test)
  });

  test("edge kind filter restricts trails", async () => {
    const b = await buildGo();
    const r = follow(b, "OpenStore", "test");
    expect(r.trails.length).toBeGreaterThan(0);
    expect(r.trails.every((t) => t.steps.every((s) => s.edge === "" || s.edge === "test"))).toBe(true);
  });

  test("qualified id resolves unambiguously", async () => {
    const b = await buildGo();
    const r = follow(b, "internal/session/store.go::OpenStore::18", "all");
    expect(r.symbol?.name).toBe("OpenStore");
  });

  test("ambiguous bare name yields candidates, never a silent pick", async () => {
    const b = await buildGo();
    // multilang fixture has MyClass in app.rb, main.cpp, main.dart
    const ml = await build(new URL("./fixtures/multilang", import.meta.url).pathname);
    ml.changed = new Set();
    const r = follow(ml, "MyClass", "all");
    expect(r.ambiguous).toBe(true);
    expect(r.candidates!.length).toBeGreaterThan(1);
    expect(r.symbol).toBeUndefined();
  });
});

describe("impact ambiguity", () => {
  test("same-name symbols in different files surface candidates", async () => {
    const ml = await build(new URL("./fixtures/multilang", import.meta.url).pathname);
    ml.changed = new Set();
    const r = impact(ml, "MyClass");
    expect(r.ambiguous).toBe(true);
    expect(r.candidates!.map((c) => c.file).sort()).toEqual(["app.rb", "main.cpp", "main.dart"]);
    expect(renderImpact(r, false)).toContain("ambiguous");
  });

  test("qualified id resolves the exact symbol", async () => {
    const ml = await build(new URL("./fixtures/multilang", import.meta.url).pathname);
    ml.changed = new Set();
    const id = ml.graph.symbols.find((s) => s.name === "MyClass" && s.file === "main.cpp")!.id;
    const r = impact(ml, id);
    expect(r.ambiguous).toBeFalsy();
    expect(r.symbol?.file).toBe("main.cpp");
  });
});

describe("map", () => {
  test("directory map groups symbols per file with spans", async () => {
    const b = await buildGo();
    const { blocks, truncated } = mapDir(b, "internal/session");
    expect(truncated).toBe(false);
    expect(blocks.map((bl) => bl.file)).toContain("internal/session/store.go");
    const store = blocks.find((bl) => bl.file === "internal/session/store.go")!;
    expect(store.syms.map((s) => s.name)).toContain("OpenStore");
    const testBlock = blocks.find((bl) => bl.file === "internal/session/store_test.go")!;
    expect(testBlock.calls.length).toBeGreaterThan(0); // test calls OpenStore/Get/Set
  });
});
