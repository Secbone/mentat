import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));

function readText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  return blocks.find((block) => block.type === "text")?.text ?? "";
}

describe("memory MCP server", () => {
  it("exposes memory_search/memory_add and round-trips entries", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mentat-mcpmem-")), "memory.json");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, MENTAT_MEMORY_FILE: file } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["memory_add", "memory_search"]);

    await client.callTool({
      name: "memory_add",
      arguments: { id: "m1", text: "the build takes 3 minutes" },
    });
    const found = await client.callTool({
      name: "memory_search",
      arguments: { query: "build" },
    });
    const entries = JSON.parse(readText(found)) as Array<{ id: string; text: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("m1");

    await client.close();
  });
});
