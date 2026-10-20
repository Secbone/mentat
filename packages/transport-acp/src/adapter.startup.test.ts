import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createAcpAdapter } from "./adapter";

it("requires a fresh matching catalog receipt, rejecting stale receipts before inference", async () => {
  const receiptPath = join(mkdtempSync(join(tmpdir(), "mentat-ready-")), "ready.jsonl");
  const token = "contract-nonce";
  writeFileSync(
    receiptPath,
    `${JSON.stringify({ event: "tools/list-sent", token, tools: ["memory_search"] })}\n`,
  );
  const make = (emit: string) =>
    createAcpAdapter({
      binary: process.execPath,
      baseArgs: [fileURLToPath(new URL("./__fixtures__/catalog-acp.mjs", import.meta.url))],
      env: { CATALOG_PATH: receiptPath, CATALOG_TOKEN: token, CATALOG_EMIT: emit },
      startupReadiness: { receiptPath, token, tools: ["memory_search"], timeoutMs: 300 },
    });
  const sent: string[] = [];
  await expect(
    make("no").createSession(
      { cwd: process.cwd() },
      {
        onProtocol: (r) => {
          if (r.direction === "out") sent.push(String((r.data as { method?: string }).method));
        },
      },
    ),
  ).rejects.toThrow("readiness timed out");
  expect(sent).not.toContain("session/prompt");
  const records: string[] = [];
  const session = await make("yes").createSession(
    { cwd: process.cwd() },
    { onDiagnostic: (r) => records.push(r.code) },
  );
  try {
    expect(records).toContain("ACP_MCP_CATALOG_READY");
  } finally {
    await session.dispose();
  }
});

it("bounds opt-in startup settling and reports it without pretending tools are ready", async () => {
  for (const value of [-1, 0.5, NaN, Infinity, 10001])
    expect(() => createAcpAdapter({ binary: process.execPath, startupSettleMs: value })).toThrow(
      RangeError,
    );
  const records: Array<{ code: string; message: string }> = [];
  const adapter = createAcpAdapter({
    binary: process.execPath,
    baseArgs: [fileURLToPath(new URL("./__fixtures__/stub-acp-agent.mjs", import.meta.url))],
    startupSettleMs: 40,
  });
  let handshakeAt = 0;
  const session = await adapter.createSession(
    { cwd: process.cwd() },
    {
      onProtocol(record) {
        const wire = record.data as { result?: { sessionId?: string } };
        if (wire.result?.sessionId) handshakeAt = Date.now();
      },
      onDiagnostic(record) {
        records.push(record);
      },
    },
  );
  try {
    expect(handshakeAt).toBeGreaterThan(0);
    expect(Date.now() - handshakeAt).toBeGreaterThanOrEqual(35);
    const settle = records.find((r) => r.code === "ACP_STARTUP_SETTLE");
    expect(JSON.parse(settle?.message ?? "{}")).toMatchObject({ milliseconds: 40 });
  } finally {
    await session.dispose();
  }
});

it("requires every declared server catalog, not just memory readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-all-ready-"));
  const receiptPath = join(root, "memory.jsonl");
  const adapter = createAcpAdapter({
    binary: process.execPath,
    baseArgs: [fileURLToPath(new URL("./__fixtures__/catalog-acp.mjs", import.meta.url))],
    env: { CATALOG_PATH: receiptPath, CATALOG_TOKEN: "nonce", CATALOG_EMIT: "yes" },
    startupReadiness: [
      { receiptPath, token: "nonce", tools: ["memory_search"], timeoutMs: 300 },
      {
        receiptPath: join(root, "missing-environment.jsonl"),
        token: "nonce",
        tools: ["notes_list"],
        timeoutMs: 100,
      },
    ],
  });
  const outgoing: string[] = [];
  await expect(
    adapter.createSession(
      { cwd: root },
      {
        onProtocol: (r) => {
          if (r.direction === "out") outgoing.push(String((r.data as { method?: string }).method));
        },
      },
    ),
  ).rejects.toThrow("catalog readiness timed out");
  expect(outgoing).not.toContain("session/prompt");
});
