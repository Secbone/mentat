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
  const memoryTools: AssistantTools = {
    ...(config.memoryTools ?? {
      memory: config.memoryPath && config.permissionMode !== "deny" ? "read-write" : "disabled",
    }),
  };
  if (memoryTools.memory !== "disabled" && !config.memoryPath)
    throw new Error("memory tools require a file-backed memory repository");
  const registerMemory = Boolean(
    config.memoryPath && memoryTools.memory !== "disabled" && memoryTools.transport !== "external",
  );
  if (registerMemory && config.adapter.capabilities().mcpToolNaming === "server-prefixed") {
    memoryTools.searchName ??= "memory_memory_search";
    memoryTools.addName ??= "memory_memory_add";
  }
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
  for (const scope of [config.scope, ...(config.sharedMemoryScopes ?? [])])
    if (
      scope !== undefined &&
      (typeof scope !== "string" || !scope.trim() || scope !== scope.trim() || scope.length > 256)
    )
      throw new Error("invalid host scope");
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  )
    throw new Error("invalid host timeout");
  for (const history of [config.history, config.nativeHistory])
    if (
      history &&
      (!Number.isSafeInteger(history.maxChars) ||
        history.maxChars < 0 ||
        (history.before !== undefined && !Number.isFinite(history.before)))
    )
      throw new Error("invalid history budget or cutoff");
  const budget = config.contextBudget;
  if (
    budget &&
    ((budget.memoryChars !== undefined &&
      (!Number.isSafeInteger(budget.memoryChars) || budget.memoryChars < 0)) ||
      (budget.maxInputChars !== undefined &&
        (!Number.isSafeInteger(budget.maxInputChars) || budget.maxInputChars <= 0)))
  )
    throw new Error("invalid host context budget");
  if (!overrides.memory && !config.memoryPath)
    throw new Error("memory implementation or memoryPath required");
  const selectedModel = config.model ?? overrides.modelSelector?.select()?.id;
  if (overrides.modelSelector && !config.model && !selectedModel)
    throw new Error("no model satisfies the configured selection policy");
  return {
    ...config,
    ...(selectedModel ? { model: selectedModel } : {}),
    cwd: resolve(config.cwd),
    ...(config.memoryPath ? { memoryPath: resolve(config.memoryPath) } : {}),
    ...(config.skillsPath ? { skillsPath: resolve(config.skillsPath) } : {}),
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
