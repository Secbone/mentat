import type { AgentEvent, AgentEventListener, HarnessAdapter, SessionHandle } from "@mentat/core";
import { defineCapabilityPack } from "@mentat/pack";
import type { TurnResult } from "@mentat/session";
import { describe, expect, it } from "vitest";
import type { WorkerTask } from "./contract";
import { FakeWorker } from "./fake";
import { HarnessWorker, reportFromTurn } from "./harness";

const task: WorkerTask = {
  assignmentId: "a1",
  ticketId: "t1",
  cwd: "/tmp",
  prompt: "do the work",
  pack: defineCapabilityPack({
    id: "test-worker",
    version: 1,
    prompt: { system: "be useful", role: "worker" },
    model: { model: "test/model" },
  }),
};

describe("reportFromTurn", () => {
  const base: TurnResult = {
    turnId: "turn",
    sessionId: "session",
    reason: "done",
    text: "finished",
    events: [],
    durationMs: 1,
  };

  it("maps a completed turn to ready", () => {
    expect(reportFromTurn(base)).toMatchObject({ kind: "ready", text: "finished" });
  });

  it("maps errors, limits and aborts", () => {
    expect(reportFromTurn({ ...base, reason: "error", error: "boom" })).toMatchObject({
      kind: "failed",
      summary: "boom",
    });
    expect(reportFromTurn({ ...base, reason: "length" }).kind).toBe("blocked");
    expect(reportFromTurn({ ...base, reason: "aborted" }).kind).toBe("waiting");
  });
});

describe("FakeWorker", () => {
  it("returns the configured report and events", async () => {
    const worker = new FakeWorker({
      report: { kind: "ready", summary: "ok" },
      events: [{ type: "settled", at: "2026-11-05T00:00:00.000Z", reason: "done" }],
    });
    const session = await worker.spawn(task);
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events).toHaveLength(1);
    expect(await session.report()).toMatchObject({ kind: "ready", summary: "ok" });
  });
});

function fakeHarness(): HarnessAdapter {
  return {
    id: "fake-harness",
    capabilities: () => ({
      steer: false,
      compact: false,
      fork: false,
      permissions: false,
      systemPrompt: "replace",
    }),
    async createSession(): Promise<SessionHandle> {
      const listeners = new Set<AgentEventListener>();
      const emit = (event: AgentEvent) => {
        for (const listener of listeners) listener(event);
      };
      return {
        id: "session-1",
        async send() {
          emit({ type: "run.started", sessionId: "session-1" });
          emit({ type: "message.delta", sessionId: "session-1", text: "hello" });
          emit({
            type: "message.completed",
            sessionId: "session-1",
            message: { role: "assistant", text: "hello" },
          });
          emit({
            type: "usage",
            sessionId: "session-1",
            usage: { inputTokens: 2, outputTokens: 3 },
          });
          emit({ type: "run.settled", sessionId: "session-1", reason: "done" });
        },
        async interrupt() {},
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async dispose() {},
      };
    },
  };
}

describe("HarnessWorker", () => {
  it("runs one turn through an existing harness and maps its events", async () => {
    const adapter = fakeHarness();
    const worker = new HarnessWorker(adapter);
    expect(worker.capabilities()).toMatchObject({ promptInjection: "system", streaming: true });
    const session = await worker.spawn(task);
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["message", "usage", "settled"]);
    expect(await session.report()).toMatchObject({ kind: "ready", text: "hello" });
  });

  it("rejects pack capabilities the adapter cannot inject", async () => {
    const worker = new HarnessWorker(fakeHarness());
    await expect(
      worker.spawn({
        ...task,
        pack: defineCapabilityPack({
          id: "unsupported",
          version: 1,
          prompt: { system: "x", role: "worker" },
          skills: [{ name: "debug" }],
        }),
      }),
    ).rejects.toThrow("skills");
  });
});
