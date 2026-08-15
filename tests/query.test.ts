import { describe, expect, test } from "bun:test";
import { rankSymbols } from "../src/query";
import { buildBm25Index } from "../src/bm25";
import type { Graph } from "../src/facts";
import type { DocFact } from "../src/doc";

const graph: Graph = {
  symbols: [
    {
      id: "src/b.ts::import::1",
      file: "src/b.ts",
      kind: "import",
      name: "modA",
      sig: "import ./a",
      span: { sl: 1, sc: 1, el: 1, ec: 1 },
      nameLine: 1,
      exported: false,
      test: false,
      doc: "",
      conf: "exact",
    },
  ],
  edges: [],
  imports: [],
};

const doc: DocFact = { file: "docs/mod.md", text: "moda module docs", sections: [{ text: "moda module docs", line: 1 }], hash: "h", size: 10, mtimeMs: 0 };

describe("rankSymbols hybrid fusion", () => {
  test("out-of-range doc rowid skips the doc hit without aborting fusion", () => {
    // index built over [doc], query runs with a mismatched docs array: the doc
    // hit's rowid points past the array. Must not abort the whole fusion.
    const idx = buildBm25Index(graph, [doc]);
    const out = rankSymbols({ task: "moda", graph, changed: new Set(), explicitFiles: [], bm25: idx, docs: [] });
    expect(out).toHaveLength(0);
    expect(out.some((h) => h.symbol.id.startsWith("doc::"))).toBe(false);
  });

  test("matching docs array appends the doc hit; imports stay excluded", () => {
    const idx = buildBm25Index(graph, [doc]);
    const out = rankSymbols({ task: "moda", graph, changed: new Set(), explicitFiles: [], bm25: idx, docs: [doc] });
    expect(out.some((h) => h.symbol.id === "doc::docs/mod.md")).toBe(true);
    expect(out.some((h) => h.symbol.id === "src/b.ts::import::1")).toBe(false);
  });
});

describe("recent-change affinity gate", () => {
  const g: Graph = {
    symbols: [
      {
        id: "store.go::OpenStore::1",
        file: "store.go",
        kind: "function",
        name: "OpenStore",
        sig: "func OpenStore(path string)",
        span: { sl: 1, sc: 1, el: 1, ec: 1 },
        nameLine: 1,
        exported: true,
        test: false,
        doc: "",
        conf: "exact",
      },
      {
        id: "migrate.go::Migrate::1",
        file: "migrate.go",
        kind: "function",
        name: "Migrate",
        sig: "func Migrate(exportPath string)",
        span: { sl: 1, sc: 1, el: 1, ec: 1 },
        nameLine: 1,
        exported: true,
        test: false,
        doc: "",
        conf: "exact",
      },
    ],
    edges: [],
    imports: [],
  };

  test("a changed file without topical affinity never enters ranking", () => {
    const out = rankSymbols({ task: "store", graph: g, changed: new Set(["migrate.go"]), explicitFiles: [], bm25: undefined, docs: [] });
    expect(out.map((h) => h.symbol.file)).toEqual(["store.go"]);
    expect(out.some((h) => h.reason.includes("recent-change"))).toBe(false);
  });

  test("a changed file with topical affinity keeps the boost", () => {
    const out = rankSymbols({ task: "store", graph: g, changed: new Set(["store.go"]), explicitFiles: [], bm25: undefined, docs: [] });
    expect(out.map((h) => h.symbol.file)).toEqual(["store.go"]);
    expect(out[0].reason).toContain("recent-change");
  });

  test("a recent-work query boosts changed files without affinity", () => {
    const out = rankSymbols({ task: "what changed recently", graph: g, changed: new Set(["migrate.go"]), explicitFiles: [], bm25: undefined, docs: [] });
    expect(out.map((h) => h.symbol.file)).toEqual(["migrate.go"]);
    expect(out[0].reason).toContain("recent-change");
  });
});

describe("long-doc section indexing", () => {  const longDoc: DocFact = {
    file: "docs/guide.md",
    text: "first section only\nsecond section only\nthird section only",
    sections: [
      { text: "first section only", line: 1 },
      { text: "second section only", line: 3 },
      { text: "third section only", line: 5 },
    ],
    hash: "h",
    size: 10,
    mtimeMs: 0,
  };

  test("a query matching only one section surfaces that section's line", () => {
    const idx = buildBm25Index(graph, [longDoc]);
    const out = rankSymbols({ task: "third section", graph, changed: new Set(), explicitFiles: [], bm25: idx, docs: [longDoc] });
    const docHit = out.find((h) => h.symbol.id === "doc::docs/guide.md");
    expect(docHit).toBeDefined();
    expect(docHit!.symbol.nameLine).toBe(5);
    expect(docHit!.reason).toContain("doc-match");
  });
});
