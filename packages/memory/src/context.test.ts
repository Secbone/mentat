import { describe, expect, it } from "vitest";
import { buildTurnContext } from "./context";
import { InMemoryMemoryStore } from "./store";

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
