import { fileURLToPath } from "node:url";
import type { McpServerSpec } from "@mentat/core";

/** Stdio MCP server that exposes the on-disk memory file to the harness. */
export function memoryMcpSpec(memoryPath: string): McpServerSpec {
  return {
    name: "memory",
    command: process.execPath,
    args: [fileURLToPath(new URL("../../../memory/src/mcp/server.mjs", import.meta.url))],
    env: { MENTAT_MEMORY_FILE: memoryPath },
  };
}
