export interface ModelDescriptor {
  id: string;
  provider: string;
  contextWindow: number;
  costPerMtok?: number;
}

export interface ModelPreferences {
  minContextWindow?: number;
  maxCostPerMtok?: number;
  preferProviders?: string[];
}

/** A selectable catalog of models; the loop can iterate its contents. */
export class ModelCatalog {
  private readonly models = new Map<string, ModelDescriptor>();

  constructor(models: ModelDescriptor[] = []) {
    for (const model of models) this.add(model);
  }

  add(model: ModelDescriptor): void {
    if (
      !model.id?.trim() ||
      !model.provider?.trim() ||
      !Number.isSafeInteger(model.contextWindow) ||
      model.contextWindow <= 0 ||
      (model.costPerMtok !== undefined &&
        (!Number.isFinite(model.costPerMtok) || model.costPerMtok < 0))
    )
      throw new Error("invalid model descriptor");
    this.models.set(model.id, { ...model });
  }

  list(): ModelDescriptor[] {
    return [...this.models.values()].map((model) => ({ ...model }));
  }

  /** Pick the cheapest model that satisfies the preferences, if any. */
  select(preferences: ModelPreferences = {}): ModelDescriptor | undefined {
    let candidates = this.list();
    const { minContextWindow, maxCostPerMtok, preferProviders } = preferences;
    if (minContextWindow !== undefined) {
      candidates = candidates.filter((model) => model.contextWindow >= minContextWindow);
    }
    if (maxCostPerMtok !== undefined) {
      candidates = candidates.filter(
        (model) => model.costPerMtok !== undefined && model.costPerMtok <= maxCostPerMtok,
      );
    }
    if (preferProviders && preferProviders.length > 0) {
      const preferred = candidates.filter((model) => preferProviders.includes(model.provider));
      if (preferred.length > 0) candidates = preferred;
    }
    candidates.sort((a, b) => (a.costPerMtok ?? Infinity) - (b.costPerMtok ?? Infinity));
    return candidates[0];
  }
}
