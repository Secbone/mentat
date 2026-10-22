import {
  type Artifact,
  type ArtifactAdapter,
  type CreateArtifactOptions,
  createArtifact,
  type Disposable,
  type JsonValue,
} from "@mentat/core";
import { ModelCatalog, type ModelDescriptor } from "./catalog";

export const MODEL_SERVICE = "mentat.models";

function parseModels(raw: unknown): ModelDescriptor[] {
  if (!Array.isArray(raw)) throw new Error("invalid model artifact: payload is not an array");
  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid model artifact: descriptor is not an object");
    const model = value as Record<string, unknown>;
    if (typeof model.id !== "string" || !model.id.trim())
      throw new Error("invalid model artifact: id is required");
    if (typeof model.provider !== "string" || !model.provider.trim())
      throw new Error("invalid model artifact: provider is required");
    if (
      typeof model.contextWindow !== "number" ||
      !Number.isSafeInteger(model.contextWindow) ||
      model.contextWindow <= 0
    )
      throw new Error("invalid model artifact: contextWindow must be a positive integer");
    if (seen.has(model.id)) throw new Error(`invalid model artifact: duplicate id ${model.id}`);
    seen.add(model.id);
    return value as unknown as ModelDescriptor;
  });
}

/** Data artifact adapter for the model catalog. */
export const modelAdapter: ArtifactAdapter<ModelDescriptor[]> = {
  kind: "model",
  form: "data",
  parse: parseModels,
  snapshot: (models): JsonValue => models as unknown as JsonValue,
  restore: (snapshot): ModelDescriptor[] => parseModels(snapshot),
  materialize: (models, host): Disposable => host.provide(MODEL_SERVICE, new ModelCatalog(models)),
  diff: (before, after) => {
    const beforeIds = new Set(before.map((model) => model.id));
    const afterIds = new Set(after.map((model) => model.id));
    return {
      changed: beforeIds.size !== afterIds.size || [...afterIds].some((id) => !beforeIds.has(id)),
      details: {
        added: [...afterIds].filter((id) => !beforeIds.has(id)).sort(),
        removed: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
      },
    };
  },
};

/** Build an immutable model-catalog artifact. */
export function modelCatalogArtifact(
  id: string,
  models: ModelDescriptor[],
  options: CreateArtifactOptions = {},
): Artifact {
  return createArtifact(modelAdapter, id, models, options);
}
