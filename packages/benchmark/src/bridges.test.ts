import { describe, expect, it } from "vitest";
import { BridgeRegistry, defaultBridges } from "./bridges";
import { BENCHMARK_CATALOG } from "./catalog";

describe("BridgeRegistry", () => {
  it("registers, dedupes and lists bridges", () => {
    const registry = new BridgeRegistry();
    registry.register({ id: "x", source: "s", runner: "native", integration: "catalogued" });
    expect(registry.get("x")?.integration).toBe("catalogued");
    expect(() =>
      registry.register({ id: "x", source: "s", runner: "native", integration: "catalogued" }),
    ).toThrow("duplicate bridge");
    expect(registry.list().map((b) => b.id)).toEqual(["x"]);
  });

  it("describes the real bridge state without inventing coverage", () => {
    const registry = defaultBridges();
    const ids = new Set(BENCHMARK_CATALOG.map((entry) => entry.id));
    for (const bridge of registry.list()) expect(ids.has(bridge.id)).toBe(true);
    expect(registry.get("longmemeval")?.integration).toBe("full-run");
    expect(registry.get("past-bench")?.integration).toBe("pipeline-smoke");
    expect(registry.get("rsi-exam")?.runner).toBe("harbor");
  });
});
