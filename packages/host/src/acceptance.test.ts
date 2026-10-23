import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { expect, it } from "vitest";
import { evaluateResult } from "./acceptance";
import { createAssistantHost } from "./host";

it("persists rejection separately from a normally finished execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-acceptance-"));
  const host = createAssistantHost(
    { cwd: root, adapter: createFakeAdapter(), memoryPath: join(root, "memory.json") },
    {
      resultEvaluator: {
        id: "test-domain",
        evaluate: async () => ({ status: "rejected", issues: ["missing value"] }),
      },
    },
  );
  try {
    const session = await host.open();
    const { result, record, acceptance } = await host.turn(session, "task");
    expect(result.reason).toBe("done");
    expect(result.completion?.verification).toBe("unverified");
    expect(acceptance).toMatchObject({ status: "rejected", evaluator: "test-domain" });
    expect(record.acceptance).toEqual(acceptance);
  } finally {
    await host.close();
  }
});

it("bounds a hanging evaluator, aborts its signal and preserves the execution result", async () => {
  let aborted = false;
  const result = {
    turnId: "t",
    sessionId: "s",
    reason: "done" as const,
    text: "response",
    events: [],
    durationMs: 1,
  };
  const acceptance = await evaluateResult(
    {
      id: "hung",
      timeoutMs: 10,
      evaluate: async ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
    },
    { text: "task" },
    result,
    new AbortController().signal,
  );
  expect(acceptance.status).toBe("error");
  expect(aborted).toBe(true);
  expect(result.reason).toBe("done");
});

it.each(["error", "aborted", "length"] as const)(
  "keeps execution %s distinct from a proposed acceptance",
  async (reason) => {
    const acceptance = await evaluateResult(
      { id: "domain", evaluate: async () => ({ status: "accepted", issues: [] }) },
      { text: "task" },
      { turnId: "t", sessionId: "s", reason, text: "partial", events: [], durationMs: 1 },
      new AbortController().signal,
    );
    expect(acceptance.status).toBe(reason === "length" ? "accepted" : "rejected");
  },
);
