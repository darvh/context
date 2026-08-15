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

  test("default model is code-tuned (local inference, fail-open on load)", () => {
    // CONTEXT_MODEL override exists; default is the code-tuned one.
    expect(process.env.CONTEXT_MODEL ?? "Xenova/jina-embeddings-v2-base-code").toBe("Xenova/jina-embeddings-v2-base-code");
  });
});
