import { describe, expect, test } from "bun:test";
import { build } from "../src/build";
import { impact, renderImpact } from "../src/impact";
import { follow, renderFollow } from "../src/follow";
import { mapDir } from "../src/repo-map";
import { buildDirCards, rankDirCards } from "../src/dirmap";
import { rankSymbols } from "../src/query";
import path from "node:path";

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

  test("renderFollow shows caller vs callee direction on the same edge kind", async () => {
    const b = await buildGo();
    const r = follow(b, "OpenStore", "all");
    const out = renderFollow(r);
    // OpenStore is called by main (inbound edge -> caller) and calls
    // Store.Get (outbound edge -> callee); both use the "call" edge kind, so
    // only the direction label distinguishes them.
    expect(out).toContain("call main cmd/server/main.go");
    expect(out).toContain("(caller)");
    expect(out).toContain("call Get internal/session/store.go");
    expect(out).toContain("(callee)");
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

describe("code<->doc links", () => {
  test("docs mentioning exported symbols produce evidence links", async () => {
    const b = await buildGo();
    const sym = b.links.find((l) => l.kind === "symbol" && l.mention === "OpenStore");
    expect(sym).toBeDefined();
    expect(sym!.doc).toBe("docs/store-guide.md");
    const path = b.links.find((l) => l.kind === "path");
    expect(path?.target).toBe("internal/session/store.go");
  });

  test("impact surfaces documented_by", async () => {
    const b = await buildGo();
    const r = impact(b, "OpenStore");
    expect(r.documentedBy.length).toBeGreaterThan(0);
    expect(r.documentedBy[0].doc).toBe("docs/store-guide.md");
    expect(renderImpact(r, false)).toContain("documented_by");
  });
});

describe("compiler facts overlay", () => {
  test("mergeOverlay upgrades confidence and adds exact edges", async () => {
    const { mergeOverlay } = await import("../src/overlay");
    const b = await buildGo();
    const overlay: Parameters<typeof mergeOverlay>[1] = {
      version: 1,
      symbols: [{ id: "internal/session/store.go::OpenStore::18", file: "internal/session/store.go", name: "OpenStore", kind: "function", line: 18, endLine: 20, sig: "func OpenStore(path string) (*Store, error)" }],
      edges: [{ from: "cmd/server/main.go::main::13", to: "internal/session/store.go::OpenStore::18", kind: "implement", at: "cmd/server/main.go:13" }],
    };
    const g = mergeOverlay(b.graph, overlay);
    const openStore = g.symbols.find((s) => s.name === "OpenStore");
    expect(openStore?.conf).toBe("exact");
    expect(openStore?.span.el).toBe(20);
    const e = g.edges.find((x) => x.kind === "implement");
    expect(e).toBeDefined();
    expect(e!.conf).toBe("exact");
    expect(e!.to).toBe("internal/session/store.go::OpenStore::18");
  });

  test("no overlay file leaves the graph unchanged", async () => {
    const { loadOverlay } = await import("../src/overlay");
    expect(await loadOverlay(path.join(import.meta.dir, "..", "spike", "fixtures", "go"))).toBeNull();
  });
});

describe("typed artifacts", () => {
  test("env vars become first-class config symbols", async () => {
    const { extractArtifacts } = await import("../src/artifacts");
    const a = await extractArtifacts("spike/fixtures/typescript", ["src/index.ts"]);
    const port = a.find((x) => x.name === "PORT");
    expect(port).toBeDefined();
    expect(port!.kind).toBe("config");
    expect(port!.conf).toBe("exact");
    expect(port!.doc).toContain("environment");
  });

  test("PORT resolves exactly in ranking", async () => {
    const b = await buildGo();
    const ts = await build("spike/fixtures/typescript");
    const hits = rankSymbols({ task: "PORT environment variable", graph: ts.graph, changed: new Set(), explicitFiles: [], bm25: undefined, docs: [] });
    expect(hits[0].symbol.name).toBe("PORT");
  });
});
