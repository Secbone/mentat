#!/usr/bin/env node

// MCP protocol handlers reuse the same domain access and transactional repository as the host.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@mentat/core";
import { createMemoryAccess } from "@mentat/memory";
import { FileMemoryRepository } from "@mentat/memory-file";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const file = process.env.MENTAT_MEMORY_FILE;
if (!file) throw new Error("MENTAT_MEMORY_FILE is required");
let seq = 0;
let limited = false;
const observe = (type, data) => {
  if (limited) return;
  const dir = process.env.MENTAT_TRACE_DIR;
  if (!dir) return;
  const fragments = join(dir, "fragments");
  mkdirSync(fragments, { recursive: true, mode: 0o700 });
  const fragment = join(fragments, `memory-${process.pid}.jsonl`);
  if (
    existsSync(fragment) &&
    statSync(fragment).size + Buffer.byteLength(JSON.stringify(data)) > 32 * 1024 * 1024
  ) {
    limited = true;
    type = "capture.gap";
    data = { reason: "MCP fragment capacity limit" };
  }
  appendFileSync(
    fragment,
    `${JSON.stringify({ schemaVersion: 1, traceId: process.env.MENTAT_TRACE_ID, eventId: randomUUID(), sourceSeq: seq++, source: "memory-mcp", ts: Date.now(), type, data: redact(data) })}\n`,
    { mode: 0o600 },
  );
};
const access = createMemoryAccess(new FileMemoryRepository(file), {
  scope: process.env.MENTAT_MEMORY_SCOPE,
  observe,
  onObserverError: (error) => console.error(`memory observation failed: ${String(error)}`),
});
const server = new McpServer({ name: "mentat-memory", version: "0.0.1" });

server.registerTool(
  "memory_search",
  {
    description: "Search the agent's persistent memory for entries relevant to a query.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().positive().optional(),
      includeCandidates: z.boolean().optional(),
    },
  },
  async ({ query, limit, includeCandidates }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          await access.search({
            text: query,
            limit,
            statuses: includeCandidates ? ["active", "candidate"] : ["active"],
          }),
        ),
      },
    ],
  }),
);

server.registerTool(
  "memory_add",
  {
    description:
      "Propose an unconfirmed memory candidate using a stable rule key as id. " +
      "This tool cannot confirm user preferences or replace active rules. " +
      "Evidence is a claimed reference, not verified user confirmation.",
    inputSchema: {
      id: z.string(),
      text: z.string(),
      tags: z.array(z.string()).optional(),
      evidence: z.string().optional(),
    },
  },
  async ({ id, text, tags, evidence }) => {
    const decision = await access.propose({
      text,
      key: id,
      kind: "fact",
      ...(tags ? { tags } : {}),
      ...(evidence ? { evidence } : {}),
    });
    if (decision.op === "add" || decision.op === "update")
      return {
        content: [
          {
            type: "text",
            text: `stored candidate ${decision.entry.id}; transaction=${decision.transactionId}; user confirmation required`,
          },
        ],
      };
    if (decision.op === "dedup") {
      return { content: [{ type: "text", text: `already stored ${id}` }] };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `rejected: ${decision.reason ?? "invalid"}` }],
    };
  },
);

await server.connect(new StdioServerTransport());
