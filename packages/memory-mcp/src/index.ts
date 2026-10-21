import { fileURLToPath } from "node:url";
import type { McpServerSpec } from "@mentat/core";

/** Stdio MCP server that exposes the on-disk memory file to the harness. */
export function memoryMcpSpec(
  memoryPath: string,
  scope?: string,
  trace?: { traceId: string; dir: string },
  options?: { readOnly?: boolean; sharedScopes?: string[] },
): McpServerSpec {
  return {
    name: "memory",
    catalogTools: options?.readOnly ? ["memory_search"] : ["memory_search", "memory_add"],
    command: process.execPath,
    args: [fileURLToPath(new URL("./loader.mjs", import.meta.url))],
    env: {
      MENTAT_MEMORY_FILE: memoryPath,
      ...(options?.readOnly ? { MENTAT_MEMORY_READ_ONLY: "true" } : {}),
      ...(scope ? { MENTAT_MEMORY_SCOPE: scope } : {}),
      ...(options?.sharedScopes
        ? { MENTAT_MEMORY_SHARED_SCOPES: JSON.stringify(options.sharedScopes) }
        : {}),
      ...(trace ? { MENTAT_TRACE_ID: trace.traceId, MENTAT_TRACE_DIR: trace.dir } : {}),
    },
  };
}
