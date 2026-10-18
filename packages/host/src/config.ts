import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { AssistantTools } from "@mentat/assistant";
import type { McpServerSpec } from "@mentat/core";
import type { HostConfig, HostOverrides } from "./host";

/** Pure constructor-time validation and derivation, kept out of the closure. */
export function validateStartupToolProbe(probe: HostConfig["startupToolProbe"]): void {
  if (
    probe &&
    (!probe.toolName ||
      !probe.expectedOutput ||
      !Number.isSafeInteger(probe.maxAttempts ?? 2) ||
      (probe.maxAttempts ?? 2) < 1 ||
      (probe.maxAttempts ?? 2) > 3)
  )
    throw new Error("invalid startup tool probe");
}

export function resolveMemoryTools(config: HostConfig): {
  memoryTools: AssistantTools;
  registerMemory: boolean;
} {
  const memoryTools = config.memoryTools ?? {
    memory: config.memoryPath && config.permissionMode !== "deny" ? "read-write" : "disabled",
  };
  if (memoryTools.memory !== "disabled" && !config.memoryPath)
    throw new Error("memory tools require a file-backed memory repository");
  const registerMemory = Boolean(
    config.memoryPath && memoryTools.memory !== "disabled" && memoryTools.transport !== "external",
  );
  return { memoryTools, registerMemory };
}

export function validateServerNames(
  registerMemory: boolean,
  mcpServers: McpServerSpec[] | undefined,
): void {
  const names = new Set(registerMemory ? ["memory"] : []);
  for (const server of mcpServers ?? []) {
    if (!server.name.trim() || names.has(server.name))
      throw new Error("duplicate or empty MCP server name");
    names.add(server.name);
  }
}

export function resolveHostPaths(config: HostConfig, overrides: HostOverrides): HostConfig {
  if (!overrides.memory && !config.memoryPath)
    throw new Error("memory implementation or memoryPath required");
  return {
    ...config,
    cwd: resolve(config.cwd),
    ...(config.memoryPath ? { memoryPath: resolve(config.memoryPath) } : {}),
  };
}

export function readRepoState(cwd: string): { revision: string; dirty: boolean | null } {
  let revision = "unknown";
  let dirty: boolean | null = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    dirty = Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {}
  return { revision, dirty };
}
