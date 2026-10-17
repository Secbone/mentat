import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEventListener, HarnessAdapter } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import { expect, it } from "vitest";

function setup(actualReceipt: boolean) {
  const inputs: string[] = [];
  let listener: AgentEventListener = () => {};
  let disposed = false;
  const adapter: HarnessAdapter = {
    id: "readiness-contract",
    capabilities: () => ({ steer: false, compact: false, fork: false, permissions: false }),
    createSession: async () => ({
      id: "s",
      subscribe: (fn) => {
        listener = fn;
        return () => {};
      },
      interrupt: async () => {},
      dispose: async () => {
        disposed = true;
      },
      send: async (input) => {
        inputs.push(input.text);
        const probe = input.text.startsWith("Infrastructure readiness check:");
        if (probe && actualReceipt && inputs.length > 1) {
          listener({
            type: "tool.start",
            sessionId: "s",
            id: "receipt",
            name: "health",
            input: {},
          });
          listener({
            type: "tool.result",
            sessionId: "s",
            id: "receipt",
            output: "hidden-nonce",
            isError: false,
          });
        }
        listener({
          type: "message.completed",
          sessionId: "s",
          message: { role: "assistant", text: probe ? "hidden-nonce" : "task answer" },
        });
        listener({ type: "run.settled", sessionId: "s", reason: "done" });
      },
    }),
  };
  const root = mkdtempSync(join(tmpdir(), "mentat-ready-host-"));
  const host = createAssistantHost({
    cwd: root,
    adapter,
    memoryPath: join(root, "memory.json"),
    memoryTools: { memory: "disabled" },
    startupToolProbe: { toolName: "health", expectedOutput: "hidden-nonce", maxAttempts: 2 },
  });
  return { host, inputs, disposed: () => disposed };
}

it("accepts only a real matching tool receipt, never model-printed diagnostic text", async () => {
  const state = setup(true);
  try {
    const session = await state.host.open();
    expect(state.inputs).toHaveLength(2);
    expect(state.inputs.join("\n")).not.toContain("hidden-nonce");
    expect((await state.host.turn(session, "real user task")).result.text).toBe("task answer");
  } finally {
    await state.host.close();
  }
});

it("fails before any user task if bounded infrastructure probes never execute", async () => {
  const state = setup(false);
  try {
    await expect(state.host.open()).rejects.toThrow("no user task submitted");
    expect(state.inputs).toHaveLength(2);
    expect(state.disposed()).toBe(true);
  } finally {
    await state.host.close();
  }
});
