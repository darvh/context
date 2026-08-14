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

const doc: DocFact = { file: "docs/mod.md", text: "moda module docs", hash: "h", size: 10, mtimeMs: 0 };

describe("rankSymbols hybrid fusion", () => {
  test("out-of-range doc rowid skips the doc hit, keeps bm25 symbol hits", () => {
    // index built over [doc], query runs with a mismatched docs array: the doc
    // hit's rowid points past the array. Must not abort the whole fusion.
    const idx = buildBm25Index(graph, [doc]);
    const out = rankSymbols({ task: "moda", graph, changed: new Set(), explicitFiles: [], bm25: idx, docs: [] });
    const sym = out.find((h) => h.symbol.id === "src/b.ts::import::1");
    expect(sym).toBeDefined();
    expect(sym?.reason).toContain("bm25");
  });

  test("matching docs array appends both doc and symbol hits", () => {
    const idx = buildBm25Index(graph, [doc]);
    const out = rankSymbols({ task: "moda", graph, changed: new Set(), explicitFiles: [], bm25: idx, docs: [doc] });
    expect(out.some((h) => h.symbol.id === "doc::docs/mod.md")).toBe(true);
    expect(out.some((h) => h.symbol.id === "src/b.ts::import::1")).toBe(true);
  });
});
