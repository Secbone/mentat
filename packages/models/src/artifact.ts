import type { Disposable, IterableArtifact, JsonValue, Runtime } from "@mentat/core";
import { ModelCatalog, type ModelDescriptor } from "./catalog";

export const MODEL_SERVICE = "mentat.models";

/** A data artifact whose payload is the model catalog. */
export function modelCatalogArtifact(id: string, models: ModelDescriptor[]): IterableArtifact {
  return {
    kind: "model",
    id,
    version: `models:${models.map((model) => model.id).join(",")}`,
    form: "data",
    apply: (runtime: Runtime): Disposable =>
      runtime.provide(MODEL_SERVICE, new ModelCatalog(models)),
    snapshot: () => models as unknown as JsonValue,
    evalSpec: () => ({ suite: "model", cases: [id], metrics: ["routing"] }),
  };
}
