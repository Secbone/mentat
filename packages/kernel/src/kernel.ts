import type { Disposable } from "@mentat/core";
import { Context } from "./context";
import type { Plugin } from "./plugin";

export interface UseOptions {
  id?: string;
}

interface PluginEntry {
  plugin: Plugin;
  scope: Context;
  dispose: () => Promise<void>;
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
    try {
      const result = await plugin.apply(scope);
      if (result) scope.effect(() => result.dispose());
    } catch (error) {
      try {
        await scope.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "plugin setup and cleanup failed");
      }
      throw error;
    }
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
      await scope.dispose();
    };
    const entry: PluginEntry = { plugin, scope, dispose };
    this.entries.push(entry);
    return { dispose };
  }

  list(): string[] {
    return this.entries.map((entry) => entry.plugin.name);
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      try {
        await entry.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.entries.length = 0;
    try {
      await this.root.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "kernel cleanup failed");
  }
}

export function createKernel(root?: Context): Kernel {
  return new Kernel(root);
}
