import { describe, expect, it } from "bun:test";
import { MemoryStore, openStore } from "./store.js";

describe("store", () => {
  it("persists values across get/set", () => {
    const s = openStore(":memory:");
    s.set("k", "v");
    expect(s.get("k")).toBe("v");
  });

  it("memory store reads back what it wrote", () => {
    const s = new MemoryStore();
    s.set("a", "1");
    expect(s.get("a")).toBe("1");
  });
});
