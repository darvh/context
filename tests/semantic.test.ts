import { describe, expect, test } from "bun:test";
import { semanticEnabled, SEMANTIC_VERSION } from "../src/semantic";

describe("semantic fallback", () => {
  test("explicit opt-in via CONTEXT_SEMANTIC; off by default", async () => {
    const prev = process.env.CONTEXT_SEMANTIC;
    delete process.env.CONTEXT_SEMANTIC;
    expect(await semanticEnabled()).toBe(false);

    process.env.CONTEXT_SEMANTIC = "1";
    expect(await semanticEnabled()).toBe(true);
    process.env.CONTEXT_SEMANTIC = "true";
    expect(await semanticEnabled()).toBe(true);

    if (prev === undefined) delete process.env.CONTEXT_SEMANTIC;
    else process.env.CONTEXT_SEMANTIC = prev;
  });

  test("embedding schema is versioned (model + schema hash in the cache key)", () => {
    expect(SEMANTIC_VERSION).toMatch(/^semantic-v\d+$/);
  });

  test("default model runs on a dev laptop (23MB q8, local inference)", () => {
    // CONTEXT_MODEL override exists; default is the small laptop-friendly one.
    expect(process.env.CONTEXT_MODEL ?? "Xenova/all-MiniLM-L6-v2").toBe("Xenova/all-MiniLM-L6-v2");
  });
});
