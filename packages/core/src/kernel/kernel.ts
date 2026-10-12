import type { Disposable } from "../types";
import { Context } from "./context";
import type { Plugin } from "./plugin";

export interface UseOptions {
  id?: string;
}

interface PluginEntry {
  plugin: Plugin;
  scope: Context;
}

/** Hosts plugins over a root {@link Context}. */
export class Kernel {
  readonly root: Context;
  private readonly entries: PluginEntry[] = [];

  constructor(root?: Context) {
    this.root = root ?? new Context(undefined, "root");
  }

  async use(plugin: Plugin, options: UseOptions = {}): Promise<Disposable> {
    for (const key of plugin.inject ?? []) {
      if (!this.root.has(key)) {
        throw new Error(`Plugin "${plugin.name}" requires missing service: ${key}`);
      }
    }

    const scope = this.root.fork(options.id ?? plugin.name);
    const result = await plugin.apply(scope);
    const entry: PluginEntry = { plugin, scope };
    this.entries.push(entry);

    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        if (result) await result.dispose();
        await scope.dispose();
        const index = this.entries.indexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
      },
    };
  }

  list(): string[] {
    return this.entries.map((entry) => entry.plugin.name);
  }

  async dispose(): Promise<void> {
    for (const entry of [...this.entries].reverse()) await entry.scope.dispose();
    this.entries.length = 0;
    await this.root.dispose();
  }
}

export function createKernel(root?: Context): Kernel {
  return new Kernel(root);
}
