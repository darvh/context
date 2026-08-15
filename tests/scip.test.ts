import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { IndexSchema } from "@c4312/scip";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadScipIndex, nameFromMoniker } from "../src/graph/scip";

describe("scip index ingest", () => {
  test("moniker names extract from language-specific descriptors", () => {
    expect(nameFromMoniker("typescript src/a.ts;func::open")).toBe("open");
    expect(nameFromMoniker("golang example.com/pkg;func NewHandler")).toBe("NewHandler");
    expect(nameFromMoniker("typescript src/a.ts;class::Store;method::get")).toBe("get");
  });

  test("binary index converts to overlay facts (definitions, refs, implementations)", async () => {
    const root = path.join(import.meta.dir, "..", "var", "scip-test-" + Date.now());
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export function open(x: string) { return helper(x) }\nexport function helper(x: string) { return x }\n");

    const idx = create(IndexSchema, {
      metadata: { version: 0, toolInfo: { name: "test", version: "1" } },
      documents: [
        {
          relativePath: "src/a.ts",
          language: "typescript",
          occurrences: [
            { symbol: "typescript src/a.ts;func::open", range: [16, 20], symbolRoles: 4 }, // definition open, line 1
            { symbol: "typescript src/a.ts;func::helper", range: [41, 47], symbolRoles: 16 }, // reference helper inside open's line
            { symbol: "typescript src/a.ts;func::helper", range: [58, 64], symbolRoles: 4 }, // definition helper, line 2
          ],
          symbols: [
            { symbol: "typescript src/a.ts;func::open", kind: 21, relationships: [{ symbol: "typescript src/base.ts;interface::Base", isImplementation: true }] },
          ],
        },
      ],
    });
    await fs.writeFile(path.join(root, "index.scip"), toBinary(IndexSchema, idx));

    const facts = await loadScipIndex(root);
    expect(facts).not.toBeNull();
    const open = facts!.symbols!.find((s) => s.name === "open");
    expect(open).toBeDefined();
    expect(open!.line).toBe(1);
    expect(open!.kind).toBe("function");
    const helper = facts!.symbols!.find((s) => s.name === "helper");
    expect(helper!.line).toBe(2);
    // reference inside open's line -> edge open -> helper
    const ref = facts!.edges!.find((e) => e.kind === "ref" && e.from.endsWith("::open::1"));
    expect(ref).toBeDefined();
    expect(ref!.to).toBe(helper!.id);
    // implementation relationship
    const impl = facts!.edges!.find((e) => e.kind === "implement");
    expect(impl).toBeDefined();
    expect(impl!.to).toBe(""); // base not defined in the index

    await fs.rm(root, { recursive: true, force: true });
  });

  test("missing index.scip returns null (tree-sitter unchanged)", async () => {
    const root = path.join(import.meta.dir, "..", "spike", "fixtures", "go");
    expect(await loadScipIndex(root)).toBeNull();
  });
});
