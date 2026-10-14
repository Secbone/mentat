import { describe, expect, it } from "vitest";
import { buildMemoryContext } from "./context";
import { InMemoryMemoryStore } from "./store";

describe("buildMemoryContext", () => {
  it("returns relevant memories, or empty when none match", () => {
    const store = new InMemoryMemoryStore();
    store.add({ id: "m1", text: "the build takes 3 minutes", createdAt: 0 });
    store.add({ id: "m2", text: "deploy target is staging", createdAt: 0 });

    const context = buildMemoryContext(store, "how long does the build take");
    expect(context).toContain("build takes 3 minutes");
    expect(context).not.toContain("deploy target");
    expect(buildMemoryContext(store, "unrelated zzz")).toBe("");
  });

  it("truncates the block to maxChars", () => {
    const store = new InMemoryMemoryStore();
    store.add({ id: "m1", text: "build ".repeat(50), createdAt: 0 });
    const context = buildMemoryContext(store, "build", { maxChars: 20 });
    expect(context.length).toBeLessThanOrEqual(21);
  });

  it("excludes candidates by default and marks them when included", () => {
    const store = new InMemoryMemoryStore();
    store.add({ id: "a", text: "deploy target is staging", createdAt: 0 });
    store.add({
      id: "c",
      text: "deploy might use blue-green",
      createdAt: 0,
      status: "candidate",
      basis: "inference",
    });
    store.add({ id: "x", text: "deploy old rule", createdAt: 0, status: "expired" });

    const confirmed = buildMemoryContext(store, "deploy");
    expect(confirmed).toContain("deploy target is staging");
    expect(confirmed).not.toContain("blue-green");
    expect(confirmed).not.toContain("expired");

    const withCandidates = buildMemoryContext(store, "deploy", { includeCandidate: true });
    expect(withCandidates).toContain("(unconfirmed) deploy might use blue-green");
  });
});
