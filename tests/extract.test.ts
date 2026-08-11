import { describe, expect, test } from "bun:test";
import { build } from "../src/build";
import type { BuildResult } from "../src/build";
import { promises as fs } from "node:fs";
import path from "node:path";

const GO = new URL("./fixtures/go", import.meta.url).pathname;
const TS = new URL("./fixtures/typescript", import.meta.url).pathname;
const PY = new URL("./fixtures/python", import.meta.url).pathname;
const ML = new URL("./fixtures/multilang", import.meta.url).pathname;

// fresh copy per build: forces a real parse (never served from the warm cache)
async function buildFresh(src: string): Promise<BuildResult> {
  const root = path.join(import.meta.dir, "..", "var", "extract-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await fs.rm(root, { recursive: true, force: true });
  await fs.cp(src, root, { recursive: true });
  const b = await build(root);
  await fs.rm(root, { recursive: true, force: true });
  return b;
}

describe("structural extraction", () => {
  test("go: symbols, signatures, imports", async () => {
    const b = await buildFresh(GO);
    const names = b.graph.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("function:OpenStore");
    expect(names).toContain("struct:Store");
    expect(names).toContain("method:Get");
    expect(names).toContain("entry:main");
    expect(names).toContain("function:TestStorePersistsAcrossRestart");
    const os = b.graph.symbols.find((s) => s.name === "OpenStore")!;
    expect(os.sig).toContain("func OpenStore(path string)");
    expect(os.file).toBe("internal/session/store.go");
    expect(os.nameLine).toBe(18);
    // parenthesized imports captured
    expect(names.filter((n) => n.startsWith("import:")).length).toBeGreaterThanOrEqual(6);
  });

  test("go: cross-file call resolution", async () => {
    const b = await buildFresh(GO);
    const os = b.graph.symbols.find((s) => s.name === "OpenStore")!;
    const callers = b.graph.edges.filter((e) => e.to === os.id && e.kind === "call");
    const files = new Set(callers.map((e) => e.at.split(":")[0]));
    expect(files).toContain("cmd/server/main.go");
    expect(files).toContain("internal/session/store_test.go");
  });

  test("typescript: declarations and tests", async () => {
    const b = await buildFresh(TS);
    const names = b.graph.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("function:openStore");
    expect(names).toContain("interface:Store");
    expect(names).toContain("class:MemoryStore");
    const routes = b.graph.symbols.filter((s) => s.kind === "route");
    expect(routes.length).toBeGreaterThanOrEqual(2);
    const tests = b.graph.symbols.filter((s) => s.test);
    expect(tests.length).toBeGreaterThan(0);
  });

  test("python: module, class, test detection", async () => {
    const b = await buildFresh(PY);
    const names = b.graph.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("function:open_store");
    expect(names).toContain("class:Store");
    expect(names).toContain("function:test_store_persists_across_get_set");
    const store = b.graph.symbols.find((s) => s.name === "open_store")!;
    expect(store.sig).toContain("def open_store");
  });

  test("rg fallback: multilang symbol extraction", async () => {
    const b = await buildFresh(ML);
    const kinds = (file: string) =>
      b.graph.symbols.filter((s) => s.file === file).map((s) => `${s.kind}:${s.name}`);
    expect(kinds("Main.java")).toEqual(expect.arrayContaining(["entry:Main", "import:List"]));
    expect(kinds("app.rb")).toEqual(expect.arrayContaining(["class:MyClass"]));
    expect(kinds("main.rs")).toEqual(expect.arrayContaining(["entry:main", "struct:Foo"]));
    expect(kinds("index.php")).toEqual(expect.arrayContaining(["class:App"]));
    expect(kinds("main.c")).toEqual(expect.arrayContaining(["entry:main"]));
    expect(kinds("main.cpp")).toEqual(expect.arrayContaining(["entry:main", "class:MyClass"]));
    expect(kinds("Program.cs")).toEqual(expect.arrayContaining(["entry:Program"]));
    expect(kinds("Main.kt")).toEqual(expect.arrayContaining(["entry:main", "entry:App"]));
    expect(kinds("main.swift")).toEqual(expect.arrayContaining(["entry:main"]));
    expect(kinds("main.sh")).toEqual(expect.arrayContaining(["entry:main"]));
    expect(kinds("init.lua")).toEqual(expect.arrayContaining(["function:myfunc"]));
    expect(kinds("Main.scala")).toEqual(expect.arrayContaining(["entry:Main"]));
    expect(kinds("main.dart")).toEqual(expect.arrayContaining(["class:MyClass"]));
  });

  test("no repo mutation: cache lives outside the tree", async () => {
    const b = await build(GO);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(new URL("./fixtures/go", import.meta.url));
    expect(entries).not.toContain(".context");
    expect(entries).not.toContain(".gitignore");
    expect(b.root.endsWith("fixtures/go")).toBe(true);
  });
});
