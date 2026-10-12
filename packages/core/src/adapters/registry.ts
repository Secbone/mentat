import type { HarnessAdapter } from "../adapter";

/** Holds the available harness adapters, keyed by id. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();

  register(adapter: HarnessAdapter): () => void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`duplicate adapter: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    return () => {
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id);
    };
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  get(id: string): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`unknown harness: ${id}`);
    return adapter;
  }

  list(): HarnessAdapter[] {
    return [...this.adapters.values()];
  }
}
