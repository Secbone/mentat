#!/usr/bin/env node
// MCP-to-upstream task tools. Only a controller-owned Unix socket is reachable.
import { appendFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const socketPath = process.env.MENTAT_BENCH_SOCKET;
const toolsPath = process.env.MENTAT_BENCH_TOOLS;
const token = process.env.MENTAT_BENCH_TOKEN;
if (!socketPath || !isAbsolute(socketPath) || !toolsPath || !isAbsolute(toolsPath) || !token)
  throw new Error("missing controller socket/catalog/token");
const tools = JSON.parse(readFileSync(toolsPath, "utf8"));
if (!Array.isArray(tools) || !tools.length) throw new Error("task tools required");
const names = new Set();
for (const tool of tools) {
  if (
    !tool ||
    Object.keys(tool).some((k) => !["name", "description", "inputSchema"].includes(k)) ||
    typeof tool.name !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(tool.name) ||
    names.has(tool.name) ||
    typeof tool.description !== "string" ||
    tool.inputSchema?.type !== "object"
  )
    throw new Error("invalid or duplicate task tool schema");
  names.add(tool.name);
}

function invoke(name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name, arguments: args });
    const req = request(
      {
        socketPath,
        path: "/call",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024)
            res.destroy(new Error("task tool output exceeds bridge limit"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200)
            return reject(new Error(`upstream task tool HTTP ${res.statusCode}`));
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString());
            if (
              !result ||
              !["ok", "error"].includes(result.status) ||
              !Object.hasOwn(result, "output")
            )
              throw new Error("invalid upstream tool envelope");
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(180000, () => req.destroy(new Error("upstream task tool timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

const server = new Server(
  { name: "mentat-upstream-environment", version: "0.0.1" },
  { capabilities: { tools: {} } },
);
// Upstream task runtimes execute stateful calls sequentially. Do not open one
// socket connection per concurrent MCP request: a burst can exhaust their
// accept backlog before the synchronous runtime finishes its current call.
// A failed call must not poison the queue or cause an implicit retry.
let dispatchTail = Promise.resolve();
function dispatch(name, args) {
  const pending = dispatchTail.then(() => invoke(name, args));
  dispatchTail = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.MENTAT_MCP_READY_FILE && process.env.MENTAT_MCP_READY_TOKEN)
    appendFileSync(
      process.env.MENTAT_MCP_READY_FILE,
      `${JSON.stringify({
        event: "tools/list-sent",
        token: process.env.MENTAT_MCP_READY_TOKEN,
        tools: tools.map((tool) => tool.name),
        pid: process.pid,
      })}\n`,
    );
  return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (!names.has(params.name))
    return {
      isError: true,
      content: [{ type: "text", text: "tool outside frozen task allowlist" }],
    };
  try {
    const result = await dispatch(params.name, params.arguments ?? {});
    return {
      isError: result.status === "error",
      content: [
        {
          type: "text",
          text: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
        },
      ],
    };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: String(error) }] };
  }
});
await server.connect(new StdioServerTransport());
