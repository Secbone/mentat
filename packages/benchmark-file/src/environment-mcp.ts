import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Controller-owned Unix socket; agents receive only declared MCP tool schemas.
 * The upstream runner owns task state, visibility and scoring. No shell/code execution.
 */
export function environmentMcpSpec(options: {
  socketPath: string;
  toolsPath: string;
  token: string;
}) {
  if (!isAbsolute(options.socketPath) || !isAbsolute(options.toolsPath) || !options.token)
    throw new Error("environment MCP requires absolute controller paths and a token");
  return {
    name: "environment",
    command: process.execPath,
    args: [fileURLToPath(new URL("./environment-server.mjs", import.meta.url))],
    env: {
      MENTAT_BENCH_SOCKET: options.socketPath,
      MENTAT_BENCH_TOOLS: options.toolsPath,
      MENTAT_BENCH_TOKEN: options.token,
    },
  };
}
