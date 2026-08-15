import { test, expect } from "bun:test";
import { resolveFacts, type FileFacts } from "../src/graph/resolve";

function ff(file: string, symbols: FileFacts["symbols"]): FileFacts {
  return { file, lang: "ts", hash: "h", symbols, edges: [], imports: [] };
}

test("resolveFacts: named import binds to definition in the module file", () => {
  const a = ff("src/a.ts", [
    { id: "src/a.ts::doThing::5", file: "src/a.ts", kind: "function", name: "doThing", sig: "", span: { sl: 5, sc: 1, el: 5, ec: 1 }, nameLine: 5, exported: true, test: false, doc: "", conf: "exact" },
    { id: "src/a.ts::helper::9", file: "src/a.ts", kind: "function", name: "helper", sig: "", span: { sl: 9, sc: 1, el: 9, ec: 1 }, nameLine: 9, exported: true, test: false, doc: "", conf: "exact" },
  ]);
  const b = ff("src/b.ts", [
    { id: "src/b.ts::main::1", file: "src/b.ts", kind: "function", name: "main", sig: "", span: { sl: 1, sc: 1, el: 1, ec: 1 }, nameLine: 1, exported: true, test: false, doc: "", conf: "exact" },
  ]);
  b.imports = [{ file: "src/b.ts", module: "./a", local: "doThing", at: "src/b.ts:1" }];
  b.edges = [{ from: "src/b.ts::main::1", to: "", name: "doThing", kind: "call", conf: "resolved", at: "src/b.ts:2" }];

  const g = resolveFacts([a, b]);
  const edge = g.edges[0];
  expect(edge.to).toBe("src/a.ts::doThing::5");
  expect(edge.conf).toBe("resolved");
});
