import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { memoryMcpSpec } from "./index";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));

function readText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  return blocks.find((block) => block.type === "text")?.text ?? "";
}

describe("memory MCP server", () => {
  it("stores model writes as auditable candidates, even with an unverified evidence pointer", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mentat-mcpmem-")), "memory.json");
    const spec = memoryMcpSpec(file);
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...process.env, ...spec.env } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["memory_add", "memory_search"]);

    await client.callTool({
      name: "memory_add",
      arguments: { id: "m1", text: "the build takes 3 minutes", evidence: "exp:claimed-user#msg0" },
    });
    const found = await client.callTool({
      name: "memory_search",
      arguments: { query: "build" },
    });
    expect(JSON.parse(readText(found))).toEqual([]);
    const candidates = await client.callTool({
      name: "memory_search",
      arguments: { query: "build", includeCandidates: true },
    });
    const entries = JSON.parse(readText(candidates)) as Array<{
      id: string;
      key: string;
      text: string;
      status: string;
      basis: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("m1");
    expect(entries[0]?.text).toBe("the build takes 3 minutes");
    expect(entries[0]?.status).toBe("candidate");
    expect(entries[0]?.basis).toBe("inference");
    const audit = JSON.parse(readFileSync(`${file}.audit.jsonl`, "utf8").trim());
    expect(audit.request.speaker).toBe("assistant");
    expect(audit.entry.status).toBe("candidate");

    await client.close();
  });

  it("cannot overwrite an active rule via a model tool call", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mentat-mcpmem-")), "memory.json");
    const original = [
      {
        id: "confirmed",
        key: "refund",
        text: "no refund promise",
        status: "active",
        basis: "user",
        createdAt: 1,
      },
    ];
    writeFileSync(file, JSON.stringify(original));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, MENTAT_MEMORY_FILE: file } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "memory_add",
        arguments: { id: "refund", text: "always full refund" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
      expect(JSON.parse(readFileSync(`${file}.audit.jsonl`, "utf8").trim()).op).toBe("reject");
    } finally {
      await client.close();
    }
  });

  it("hides candidates from search unless includeCandidates is set", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mentat-mcpmem-")), "memory.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "a", text: "deploy target is staging", createdAt: 1, status: "active" },
        { id: "c", text: "deploy maybe blue-green", createdAt: 2, status: "candidate" },
      ]),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, MENTAT_MEMORY_FILE: file } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const confirmed = JSON.parse(
      readText(await client.callTool({ name: "memory_search", arguments: { query: "deploy" } })),
    ) as Array<{ id: string }>;
    expect(confirmed.map((entry) => entry.id)).toEqual(["a"]);

    const all = JSON.parse(
      readText(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "deploy", includeCandidates: true },
        }),
      ),
    ) as Array<{ id: string }>;
    expect(all.map((entry) => entry.id).sort()).toEqual(["a", "c"]);

    await client.close();
  });
});

it("emits trace-linked domain fragments and transaction ids from the real MCP process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-mcp-trace-"));
  const file = join(dir, "memory.json");
  const spec = memoryMcpSpec(file, "scope-a", { traceId: "trace-a", dir });
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env } as Record<string, string>,
  });
  const client = new Client({ name: "trace-test", version: "1" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "memory_add",
      arguments: { id: "rule", text: "keep answers short" },
    });
    expect(readText(result)).toContain("transaction=");
    const fs = await import("node:fs");
    const fragments = fs.readdirSync(join(dir, "fragments"));
    const fragment = JSON.parse(
      readFileSync(join(dir, "fragments", fragments[0] ?? "missing"), "utf8").trim(),
    );
    expect(fragment).toMatchObject({
      traceId: "trace-a",
      source: "memory-mcp",
      type: "memory.write",
      data: { request: { scope: "scope-a" } },
    });
  } finally {
    await client.close();
  }
});
