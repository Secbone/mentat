import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { environmentMcpSpec } from "./environment-mcp";

it("executes only upstream-declared tools over an authenticated local socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-upstream-tools-"));
  const socketPath = join(root, "env.sock"),
    toolsPath = join(root, "tools.json"),
    token = randomUUID();
  writeFileSync(
    toolsPath,
    JSON.stringify([
      {
        name: "lookup",
        description: "Fixture task lookup",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    ]),
  );
  const calls: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    const busyUntil = Date.now() + 10;
    while (Date.now() < busyUntil) {
      /* fixture simulates a synchronous upstream runtime */
    }
    calls.push(call);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        status: "ok",
        output: { id: call.arguments.id, source: "upstream-runtime" },
      }),
    );
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath, backlog: 1 }, ready);
  });
  const spec = environmentMcpSpec({ socketPath, toolsPath, token });
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env } as Record<string, string>,
  });
  const client = new Client({ name: "contract", version: "0.0.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["lookup"]);
    const response = await client.callTool({ name: "lookup", arguments: { id: "A" } });
    expect(response.isError).toBe(false);
    expect(JSON.stringify(response.content)).toContain("upstream-runtime");
    const denied = await client.callTool({ name: "read_private_labels", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(calls).toEqual([{ name: "lookup", arguments: { id: "A" } }]);
    const concurrent = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        client.callTool({ name: "lookup", arguments: { id: `parallel-${index}` } }),
      ),
    );
    expect(concurrent.every((result) => result.isError === false)).toBe(true);
    const unauthorized = new Client({ name: "unauthorized", version: "0.0.0" });
    try {
      await unauthorized.connect(
        new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          env: { ...process.env, ...spec.env, MENTAT_BENCH_TOKEN: "wrong-token" } as Record<
            string,
            string
          >,
        }),
      );
      expect(
        (await unauthorized.callTool({ name: "lookup", arguments: { id: "private" } })).isError,
      ).toBe(true);
      expect(calls).toHaveLength(25);
    } finally {
      await unauthorized.close();
    }
  } finally {
    await client.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
