import { Context } from "@mentat/kernel";
import { describe, expect, it } from "vitest";
import { MODEL_SERVICE, modelCatalogArtifact } from "./artifact";
import { ModelCatalog, type ModelDescriptor } from "./catalog";

const models: ModelDescriptor[] = [
  { id: "big", provider: "a", contextWindow: 200000, costPerMtok: 10 },
  { id: "small", provider: "b", contextWindow: 8000, costPerMtok: 1 },
  { id: "mid", provider: "a", contextWindow: 32000, costPerMtok: 3 },
];

describe("ModelCatalog", () => {
  it("filters by context window and cost, then picks cheapest", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.select({ minContextWindow: 16000, maxCostPerMtok: 5 })?.id).toBe("mid");
    expect(catalog.select({ maxCostPerMtok: 2 })?.id).toBe("small");
  });

  it("prefers providers when available", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.select({ preferProviders: ["b"] })?.id).toBe("small");
  });

  it("returns undefined when nothing matches", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.select({ minContextWindow: 1_000_000 })).toBeUndefined();
  });
});

describe("modelCatalogArtifact", () => {
  it("provides a catalog when applied", async () => {
    const runtime = new Context();
    await modelCatalogArtifact("c", models).apply(runtime);
    expect(runtime.get<ModelCatalog>(MODEL_SERVICE).list()).toHaveLength(3);
    await runtime.dispose();
  });
});
