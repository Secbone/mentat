import { describe, expect, it } from "vitest";
import { rememberFact } from "./remember";
import { InMemoryMemoryStore } from "./store";

describe("rememberFact", () => {
  it("adds once and dedups by trimmed text", () => {
    const store = new InMemoryMemoryStore();
    const first = rememberFact(store, "the build takes 3 minutes", 1);
    expect(first?.id).toBeTruthy();
    expect(store.list()).toHaveLength(1);

    const duplicate = rememberFact(store, "  the build takes 3 minutes  ", 2);
    expect(duplicate).toBeUndefined();
    expect(store.list()).toHaveLength(1);

    expect(rememberFact(store, "   ")).toBeUndefined();
  });
});
