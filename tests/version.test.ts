import { describe, expect, test } from "bun:test";
import { buildInfo, runtimeKind } from "../src/cli/version";
import { CACHE_VERSION } from "../src/cache";

describe("build identity", () => {
  test("--version carries version, build, cache schema, and runtime kind", async () => {
    const info = await buildInfo();
    expect(info).toMatch(/^context \d+\.\d+\.\d+ \(build .+, cache-schema context-cache-v\d+, runtime (source|compiled)\)$/);
    expect(info).toContain(CACHE_VERSION);
  });

  test("runtime kind is one of the two supported runtimes", () => {
    expect(["source", "compiled"]).toContain(runtimeKind());
  });
});
