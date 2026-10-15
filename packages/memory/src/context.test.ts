import { describe, expect, it } from "vitest";
import { buildMemoryContext, buildTurnContext } from "./context";
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

describe("turn context budget", () => {
  it("fits a whole required constraint exactly at the budget boundary", () => {
    const store = new InMemoryMemoryStore();
    store.add({ id: "deadline", text: "11点前回家", kind: "constraint", createdAt: 0 });
    const size = buildTurnContext(store, "周末").text.length;
    expect(buildTurnContext(store, "周末", size).omittedRequiredIds).toEqual([]);
    expect(buildTurnContext(store, "周末", size - 1).omittedRequiredIds).toEqual(["deadline"]);
  });
  it("reserves room for a constraint behind many preferences regardless of insertion order", () => {
    for (const first of [false, true]) {
      const store = new InMemoryMemoryStore();
      const constraint = {
        id: "deadline",
        text: "11点前回家",
        kind: "constraint" as const,
        createdAt: 0,
      };
      if (first) store.add(constraint);
      for (let i = 0; i < 80; i += 1)
        store.add({
          id: `noise-${i}`,
          text: "无关偏好".repeat(30),
          tags: ["preference"],
          createdAt: i,
        });
      if (!first) store.add(constraint);
      const context = buildTurnContext(store, "出门办事", 200);
      expect(context.text).toContain("11点前回家");
      expect(context.omittedRequiredIds).toEqual([]);
    }
  });

  it("reports required constraints that cannot fit whole, rather than silently dropping them", () => {
    const store = new InMemoryMemoryStore();
    store.add({ id: "large", text: "约束".repeat(200), tags: ["constraint"], createdAt: 0 });
    const context = buildTurnContext(store, "安排", 100);
    expect(context.omittedRequiredIds).toEqual(["large"]);
    expect(context.requiredIds).toEqual(["large"]);
    expect(context.text.length).toBeLessThanOrEqual(100);
  });
  it("excludes inactive entries from every selection path, including pinned constraints", () => {
    const store = new InMemoryMemoryStore();
    store.add({ id: "active", text: "weekend active", createdAt: 0, status: "active" });
    for (const status of ["candidate", "expired", "superseded", "archived"] as const) {
      store.add({
        id: status,
        text: `weekend ${status}`,
        tags: ["constraint"],
        createdAt: 10,
        status,
      });
    }
    const context = buildTurnContext(store, "weekend");
    expect(context.text).toContain("weekend active");
    for (const status of ["candidate", "expired", "superseded", "archived"]) {
      expect(context.text).not.toContain(`weekend ${status}`);
    }
  });
  it("prioritizes tagged preferences, includes small legacy stores and never slices an entry", () => {
    const store = new InMemoryMemoryStore();
    store.add({ id: "noise", text: "x".repeat(100), createdAt: 10 });
    store.add({ id: "rule", text: "11点前回家", tags: ["constraint"], createdAt: 0 });
    const context = buildTurnContext(store, "other", 100);
    expect(context.text).toContain("11点前回家");
    expect(context.omittedIds).toEqual(["noise"]);
    expect(() => JSON.parse(context.text)).not.toThrow();
    expect(buildTurnContext(store, "other").text).toContain("noise");
  });
});
