import type { PermissionMode } from "@mentat/core";
import { AdapterRegistry, createFakeAdapter } from "@mentat/core";
import type { AcpAdapterOptions } from "@mentat/transport-acp";
import { createAcpAdapter } from "@mentat/transport-acp";
import { createPiAdapter } from "@mentat/transport-pi";
import { createOpenCodeAdapter } from "./opencode";

export interface AcpRegistration {
  binary: string;
  baseArgs?: string[];
  env?: Record<string, string>;
  startupSettleMs?: number;
  startupReadiness?: AcpAdapterOptions["startupReadiness"];
}

export interface RegistryOptions {
  /** Explicit ACP registration; defaults to `MENTAT_ACP_BIN` when set. */
  acp?: AcpRegistration;
  /** OpenCode-specific system-prompt control, separate from generic ACP. */
  opencode?: AcpRegistration;
}

function acpFromEnv(): AcpRegistration | undefined {
  const binary = process.env.MENTAT_ACP_BIN;
  if (!binary) return undefined;
  const args = process.env.MENTAT_ACP_ARGS;
  return { binary, ...(args ? { baseArgs: args.split(/\s+/).filter(Boolean) } : {}) };
}

/**
 * Assemble the default harness registry: the dependency-free fake adapter, the
 * Pi RPC adapter, and — when configured via `MENTAT_ACP_BIN` — the generic ACP
 * adapter. Adding an engine only requires registering it here.
 */
export function createDefaultRegistry(
  permissionMode: PermissionMode = "auto",
  options: RegistryOptions = {},
): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createFakeAdapter());
  registry.register(createPiAdapter({ permissionMode }));

  const acp = options.acp ?? acpFromEnv();
  registry.register(createOpenCodeAdapter(options.opencode ?? { binary: "opencode" }));
  if (acp) {
    registry.register(
      createAcpAdapter({
        binary: acp.binary,
        baseArgs: acp.baseArgs ?? ["acp"],
        ...(acp.env ? { env: acp.env } : {}),
        ...(acp.startupSettleMs !== undefined ? { startupSettleMs: acp.startupSettleMs } : {}),
        ...(acp.startupReadiness ? { startupReadiness: acp.startupReadiness } : {}),
      }),
    );
  }
  return registry;
}
