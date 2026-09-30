import { describe, expect, test } from "bun:test";
import { extractDoc } from "../src/core/doc";

/**
 * The docs lane must start without the optional native converter: a checkout
 * installed for another platform used to kill the whole CLI at import time.
 */
describe("document extraction", () => {
  test("prose and markup extract without the native converter", async () => {
    const markdown = new TextEncoder().encode("# Title\n\nSome prose.\n");
    const fact = await extractDoc("notes.md", markdown);
    expect(fact.text).toContain("Some prose.");
    expect(fact.sections.length).toBeGreaterThan(0);
  });

  test("office bytes that cannot be converted fail open", async () => {
    const garbage = new Uint8Array([0x50, 0x4b, 0x01, 0x02, 0x03]);
    const fact = await extractDoc("broken.docx", garbage);
    expect(fact.text).toBe("");
    expect(fact.sections).toEqual([]);
  });

  test("importing the docs lane does not statically require the converter", async () => {
    const source = await Bun.file(new URL("../src/core/doc.ts", import.meta.url)).text();
    expect(source.includes('import { toMarkdownBytes } from "@firecrawl/anydoc"')).toBe(false);
    expect(source.includes('import("@firecrawl/anydoc")')).toBe(true);
  });
});
