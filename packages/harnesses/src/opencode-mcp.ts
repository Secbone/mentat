import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSpec } from "@mentat/core";
import type { McpCatalogReadiness } from "@mentat/transport-acp";

/** Explicit process metadata for servers implementing Mentat's catalog receipt contract. */
export type CatalogServer = McpServerSpec & { catalogTools?: string[] };

/** OpenCode's ACP stdio-server format does not retain codemode:false. Configure
 * these servers natively so a permission-denied execute tool cannot hide them.
 * Only our owned temporary receipt directory is cleaned up.
 */
export function prepareOpenCodeMcp(servers: CatalogServer[]) {
  const root = servers.some((s) => s.catalogTools?.length)
    ? mkdtempSync(join(tmpdir(), "mentat-catalog-"))
    : undefined;
  const catalog: McpCatalogReadiness[] = [];
  const configured: Record<
    string,
    { type: "local"; codemode: false; command: string[]; environment: Record<string, string> }
  > = {};
  try {
    for (const [index, server] of servers.entries()) {
      if (!/^[A-Za-z0-9_-]+$/.test(server.name) || Object.hasOwn(configured, server.name))
        throw new Error("invalid or duplicate OpenCode MCP namespace");
      const environment = { ...server.env };
      if (server.catalogTools?.length) {
        if (!root) throw new Error("missing catalog receipt directory");
        if (server.catalogTools.some((name) => !name || !/^[A-Za-z0-9_-]+$/.test(name)))
          throw new Error("invalid MCP readiness tool name");
        const receiptPath = join(root, `${index}.jsonl`),
          token = randomUUID();
        environment.MENTAT_MCP_READY_FILE = receiptPath;
        environment.MENTAT_MCP_READY_TOKEN = token;
        catalog.push({ receiptPath, token, tools: [...server.catalogTools] });
      }
      configured[server.name] = {
        type: "local",
        codemode: false,
        command: [server.command, ...(server.args ?? [])],
        environment,
      };
    }
  } catch (error) {
    if (root) rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    servers: configured,
    catalog,
    dispose: () => {
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}
