import type { Disposable, MaybePromise } from "../types";
import type { Context } from "./context";

export type PluginSetup = (ctx: Context) => MaybePromise<void | Disposable>;

/**
 * A unit of extensibility. Adapters, policies, tools and the loop itself are
 * all plugins. `inject` lists required service keys, checked before apply.
 */
export interface Plugin {
  name: string;
  inject?: string[];
  apply: PluginSetup;
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
