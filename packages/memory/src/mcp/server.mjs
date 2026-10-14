#!/usr/bin/env node
// Mentat memory MCP server (stdio). Exposes `memory_search` and `memory_add`
// over a JSON memory file so any MCP-capable harness can read/write the agent's
// persistent memory on demand ("fast weights"). Standalone JS on purpose: it is
// spawned as a subprocess and must not depend on a TS loader.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decideWrite, isRetrievable } from "../write-rules.mjs";

const file = process.env.MENTAT_MEMORY_FILE;
if (!file) {
  console.error("MENTAT_MEMORY_FILE is required");
  process.exit(1);
}

function load() {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(entries) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function search(query, limit, includeCandidates = false) {
  // Filter first (status), then rank, so expired rules and model inferences
  // cannot win on similarity alone.
  const entries = load().filter((entry) => isRetrievable(entry, includeCandidates));
  const terms = tokenize(query ?? "");
  if (terms.length === 0) return entries.slice(0, limit ?? entries.length);
  const scored = [];
  for (const entry of entries) {
    const tokens = new Set(tokenize(entry.text ?? ""));
    const score = terms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit ?? scored.length).map((item) => item.entry);
}

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
    content: [{ type: "text", text: JSON.stringify(search(query, limit, includeCandidates)) }],
  }),
);

server.registerTool(
  "memory_add",
  {
    description:
      "Store a durable memory entry. Provide a stable id (upserts on id). " +
      "`evidence` points at the message/tool that supports it.",
    inputSchema: {
      id: z.string(),
      text: z.string(),
      tags: z.array(z.string()).optional(),
      evidence: z.string().optional(),
    },
  },
  async ({ id, text, tags, evidence }) => {
    const entries = load();
    // Route through the shared write rules so MCP writes obey the same
    // source/scope/key rules as the in-process MemoryService.
    const decision = decideWrite(
      entries,
      {
        text,
        key: id,
        kind: "fact",
        basis: "user",
        speaker: "user",
        ...(tags ? { tags } : {}),
        ...(evidence ? { evidence } : {}),
      },
      Date.now(),
    );
    if (decision.op === "add" || decision.op === "update") {
      const index = entries.findIndex((item) => item.id === decision.entry.id);
      if (index >= 0) entries[index] = decision.entry;
      else entries.push(decision.entry);
      save(entries);
      return { content: [{ type: "text", text: `stored memory ${id}` }] };
    }
    if (decision.op === "dedup") {
      return { content: [{ type: "text", text: `already stored ${id}` }] };
    }
    return { content: [{ type: "text", text: `rejected: ${decision.reason ?? "invalid"}` }] };
  },
);

await server.connect(new StdioServerTransport());
