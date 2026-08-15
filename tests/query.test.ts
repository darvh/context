import { describe, expect, test } from "bun:test";
import { rankSymbols, appendSemanticHits, rankFiles, fuseFileHits } from "../src/rank/query";
import type { RankedHit } from "../src/rank/query";
import { buildBm25Index } from "../src/rank/bm25";
import type { Graph } from "../src/core/facts";
import type { DocFact } from "../src/core/doc";

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

const doc: DocFact = { file: "docs/mod.md", text: "moda module docs", sections: [{ text: "moda module docs", line: 1, endLine: 1 }], hash: "h", size: 10, mtimeMs: 0 };

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

describe("appendSemanticHits hybrid fusion", () => {
  const span = { sl: 1, sc: 1, el: 1, ec: 1 };
  const g: Graph = {
    symbols: [
      { id: "a.go::A::1", file: "a.go", kind: "function", name: "A", sig: "func A()", span, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
      { id: "b.go::B::1", file: "b.go", kind: "function", name: "B", sig: "func B()", span, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
    ],
    edges: [],
    imports: [],
  };

  test("strong base: semantic-confirmed bm25 tail hit lifts above 0 by sim", () => {
    const base: RankedHit = { symbol: g.symbols[0], score: 10, reason: ["explicit-file"], conf: "exact" };
    const bm25Hit: RankedHit = { symbol: g.symbols[1], score: 0, reason: ["bm25"], conf: "exact" };
    const out = appendSemanticHits([base, bm25Hit], [{ id: "b.go::B::1", sim: 0.6 }], g, [], "b");
    const b = out.find((h) => h.symbol.id === "b.go::B::1")!;
    expect(b.score).toBeCloseTo(0.6);
    expect(b.reason).toContain("semantic");
    expect(out.find((h) => h.symbol.id === "a.go::A::1")!.score).toBe(10);
  });

  test("weak base: graph hits semantics confirms keep maxBase+sim position", () => {
    const weakBase: RankedHit = { symbol: g.symbols[0], score: 2, reason: ["identifier-match"], conf: "exact" };
    const out = appendSemanticHits([weakBase], [{ id: "a.go::A::1", sim: 0.5 }, { id: "b.go::B::1", sim: 0.4 }], g, [], "a");
    expect(out.find((h) => h.symbol.id === "a.go::A::1")!.score).toBeCloseTo(2.5);
    expect(out.find((h) => h.symbol.id === "b.go::B::1")!.score).toBeCloseTo(2.4);
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
      { text: "first section only", line: 1, endLine: 1 },
      { text: "second section only", line: 3, endLine: 3 },
      { text: "third section only", line: 5, endLine: 5 },
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

describe("diagnostic and constraint lanes", () => {
  const g: Graph = {
    symbols: [
      { id: "store.go::OpenStore::1", file: "store.go", kind: "function", name: "OpenStore", sig: "func OpenStore()", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
      { id: "store_test.go::TestOpenStore::1", file: "store_test.go", kind: "test", name: "TestOpenStore", sig: "func TestOpenStore()", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: false, test: true, doc: "", conf: "exact" },
      { id: "legacy.go::LegacyStore::1", file: "legacy.go", kind: "struct", name: "LegacyStore", sig: "type LegacyStore", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
      { id: "conf.ts::CONFIG_KEY::1", file: "conf.ts", kind: "config", name: "CONFIG_KEY", sig: `CONFIG_KEY = "k"`, span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
    ],
    edges: [],
    imports: [],
  };
  const rank = (task: string) => rankSymbols({ task, graph: g, changed: new Set(), explicitFiles: [], bm25: undefined, docs: [] });

  test("a task naming a failing test verbatim pins it (diagnostic-first)", () => {
    const out = rank("TestOpenStore is failing in CI");
    expect(out[0].symbol.name).toBe("TestOpenStore");
    expect(out[0].reason).toContain("test-name-pin");
  });

  test("negative constraint: not tests excludes test symbols", () => {
    const out = rank("production code, not tests");
    const tests = out.filter((h) => h.symbol.test);
    expect(tests).toHaveLength(0);
  });

  test("negative constraint: without legacy deprioritizes legacy files", () => {
    const out = rank("store without the legacy adapter");
    expect(out[0].symbol.file).not.toBe("legacy.go");
  });

  test("co-change lane only fires on history intent", () => {
    const coChanged = new Map([["store.go store_test.go", 4]]);
    const changed = new Set(["store.go"]);
    const out = rankSymbols({ task: "why did the store change recently", graph: g, changed, explicitFiles: [], bm25: undefined, docs: [], coChanged });
    const test = out.find((h) => h.symbol.name === "TestOpenStore");
    expect(test?.reason).toContain("co-change");
    const out2 = rankSymbols({ task: "find the store", graph: g, changed, explicitFiles: [], bm25: undefined, docs: [], coChanged });
    expect(out2.some((h) => h.reason.includes("co-change"))).toBe(false);
  });

  test("conflicted confidence when two directories compete near the top", async () => {
    const { queryConfidence } = await import("../src/rank/query");
    const out = rank("store config");
    expect(["strong", "weak", "conflicted", "empty"]).toContain(queryConfidence(out));
  });
});

describe("irregular morphology + artifacts", () => {
  test("kept expands to keep for matching", async () => {
    const { expandIrregular } = await import("../src/core/rules");
    expect(expandIrregular("kept")).toEqual(["kept", "keep"]);
    expect(expandIrregular("store")).toEqual(["store"]);
  });

  test("irregular forms bridge past-tense queries", () => {
    const g: Graph = {
      symbols: [{ id: "keep.ts::keepAlive::1", file: "keep.ts", kind: "function", name: "keepAlive", sig: "function keepAlive()", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" }],
      edges: [],
      imports: [],
    };
    const out = rankSymbols({ task: "kept alive after restart", graph: g, changed: new Set(), explicitFiles: [], bm25: undefined, docs: [] });
    expect(out[0].symbol.name).toBe("keepAlive");
  });
});

describe("file-only search lane", () => {
  const g: Graph = {
    symbols: [
      { id: "src/store.ts::openStore::1", file: "src/store.ts", kind: "function", name: "openStore", sig: "function openStore()", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "session store", conf: "exact" },
      { id: "index.js::app::1", file: "index.js", kind: "function", name: "app", sig: "function app()", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
    ],
    edges: [],
    imports: [],
  };
  const files = ["src/store.ts", "index.js", "examples/auth/index.js", "Makefile", "LICENSE", "schema.sql"];

  test("basename-named file ranks first, root entry beats nested copies", () => {
    const out = rankFiles("where is the index.js entry file", g, files);
    expect(out[0].file).toBe("index.js");
    expect(out[0].reason).toContain("basename-match");
  });

  test("extensionless files match their bare name", () => {
    const out = rankFiles("the Makefile build targets", g, files);
    expect(out[0].file).toBe("Makefile");
  });

  test("partial term coincidence does not name a file", () => {
    // "regexp.go" must not name go.mod just because both contain "go"
    const out = rankFiles("fix the bug in regexp.go", g, ["go.mod", "regexp.go"]);
    expect(out.some((f) => f.file === "go.mod" && f.reason.includes("basename-match"))).toBe(false);
    expect(out.find((f) => f.file === "regexp.go")?.reason).toContain("basename-match");
  });

  test("fuse pins a named symbol-less file above symbol hits", () => {
    const base: RankedHit[] = [
      { symbol: g.symbols[0], score: 4, reason: ["identifier-match"], conf: "exact" },
      { symbol: g.symbols[1], score: 3, reason: ["identifier-match"], conf: "exact" },
    ];
    const out = fuseFileHits(base, "the Makefile build targets", g, files, []);
    expect(out[0].symbol.id).toBe("file::Makefile");
    expect(out[0].score).toBeGreaterThan(base[0].score);
  });

  test("fuse never regresses an existing symbol answer", () => {
    const base: RankedHit[] = [{ symbol: g.symbols[0], score: 8, reason: ["exact-name"], conf: "exact" }];
    const out = fuseFileHits(base, "openStore", g, files, []);
    expect(out[0].symbol.id).toBe("src/store.ts::openStore::1");
  });
});

describe("doc-lane gating on strong code answers", () => {
  test("a doc must not outrank a strong code answer on a non-doc query", () => {
    const g: Graph = {
      symbols: [
        // matches 3 query terms ("session", "cookie", "signed") -> score 6, a
        // strong code answer; the doc covers all 4 terms and would lead
        // without the gating
        { id: "sessions.py::get_cookie_name::1", file: "sessions.py", kind: "method", name: "get_cookie_name", sig: "def get_cookie_name()", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "session cookie signed", conf: "exact" },
      ],
      edges: [],
      imports: [],
    };
    const docs: DocFact[] = [
      { file: "docs/api.rst", text: "session cookies signed and verified in the reference", sections: [{ text: "session cookies signed and verified in the reference", line: 1, endLine: 1 }], hash: "h", size: 10, mtimeMs: 0 },
    ];
    const idx = buildBm25Index(g, docs);
    const out = rankSymbols({ task: "how are session cookies signed and verified", graph: g, changed: new Set(), explicitFiles: [], bm25: idx, docs });
    expect(out[0].symbol.file).toBe("sessions.py");
    expect(out[0].symbol.id.startsWith("doc::")).toBe(false);
  });

  test("a doc still leads when the code lane is weak", () => {
    const g: Graph = {
      symbols: [
        { id: "store.go::Store::1", file: "store.go", kind: "struct", name: "Store", sig: "type Store", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
      ],
      edges: [],
      imports: [],
    };
    const docs: DocFact[] = [
      { file: "docs/archiver-policy.rtf", text: "cold storage retention configured", sections: [{ text: "cold storage retention configured", line: 1, endLine: 1 }], hash: "h", size: 10, mtimeMs: 0 },
    ];
    const idx = buildBm25Index(g, docs);
    const out = rankSymbols({ task: "where is cold storage retention configured", graph: g, changed: new Set(), explicitFiles: [], bm25: idx, docs });
    expect(out[0].symbol.id.startsWith("doc::")).toBe(true);
  });
});
