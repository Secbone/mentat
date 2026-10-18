import {
  type AgentEventListener,
  createFakeAdapter,
  type HarnessAdapter,
  MemoryTracer,
  type SessionHandle,
} from "@mentat/core";
import { describe, expect, it, vi } from "vitest";
import { openSession, runOnce, runTurn } from "./turn";

function handle(send: (listener: AgentEventListener) => Promise<void>): SessionHandle {
  let listener: AgentEventListener = () => {};
  return {
    id: "s",
    send: () => send(listener),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
    interrupt: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}
describe("turn execution contract", () => {
  it("rejects leaked protocol as an incomplete answer without manufacturing tool events", async () => {
    const tracer = new MemoryTracer();
    const session = handle(async (listener) => {
      listener({
        type: "message.completed",
        sessionId: "s",
        message: { role: "assistant", text: "<｜｜DSML｜｜ calls>fake</｜｜DSML｜｜ calls>" },
      });
      listener({ type: "run.settled", sessionId: "s", reason: "done" });
    });
    const result = await runTurn(
      session,
      { text: "answer a question" },
      { requireFinalAnswer: true, tracer },
    );
    expect(result.reason).toBe("error");
    expect(result.error).toContain("tool-protocol-text");
    expect(result.events.some((event) => event.type === "tool.start")).toBe(false);
    expect(result.events.at(-1)).toMatchObject({ type: "run.settled", reason: "error" });
  });
  it("re-asks once after leaked protocol, then accepts the corrected answer", async () => {
    let calls = 0;
    let listener: AgentEventListener = () => {};
    const session: SessionHandle = {
      id: "s",
      send: async () => {
        calls += 1;
        listener({
          type: "message.completed",
          sessionId: "s",
          message: {
            role: "assistant",
            text:
              calls === 1
                ? "<｜｜DSML｜｜ calls>fake</｜｜DSML｜｜ calls>"
                : "the build takes 3 minutes",
          },
        });
        listener({ type: "run.settled", sessionId: "s", reason: "done" });
      },
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = () => {};
        };
      },
      interrupt: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const result = await runTurn(
      session,
      { text: "answer a question" },
      { requireFinalAnswer: true, correctiveRetries: 1 },
    );
    expect(result.reason).toBe("done");
    expect(result.text).toBe("the build takes 3 minutes");
    expect(result.correctiveTurns).toBe(1);
    expect(calls).toBe(2);
  });
  it("stops after the corrective budget is exhausted", async () => {
    const session = handle(async (listener) => {
      listener({
        type: "message.completed",
        sessionId: "s",
        message: { role: "assistant", text: "<｜｜DSML｜｜ calls>fake</｜｜DSML｜｜ calls>" },
      });
      listener({ type: "run.settled", sessionId: "s", reason: "done" });
    });
    const result = await runTurn(
      session,
      { text: "answer a question" },
      { requireFinalAnswer: true, correctiveRetries: 1 },
    );
    expect(result.reason).toBe("error");
    expect(result.error).toContain("tool-protocol-text");
    expect(result.correctiveTurns).toBe(1);
  });
  it("allows protocol documentation when answer validation is not requested", async () => {
    const session = handle(async (listener) => {
      listener({
        type: "message.completed",
        sessionId: "s",
        message: { role: "assistant", text: "Example: <｜｜DSML｜｜ calls>" },
      });
      listener({ type: "run.settled", sessionId: "s", reason: "done" });
    });
    expect((await runTurn(session, { text: "document the protocol" })).reason).toBe("done");
  });
  it("does not confuse send acknowledgement with completion", async () => {
    const session = handle(async (listener) => {
      setTimeout(() => {
        listener({
          type: "message.completed",
          sessionId: "s",
          message: { role: "assistant", text: "answer" },
        });
        listener({ type: "run.settled", sessionId: "s", reason: "done" });
      }, 10);
    });
    expect(await runTurn(session, { text: "task" })).toMatchObject({
      reason: "done",
      text: "answer",
    });
    expect(session.dispose).not.toHaveBeenCalled();
  });
  it("retains partial output with error rather than treating it as success", async () => {
    const session = handle(async (listener) => {
      listener({
        type: "message.completed",
        sessionId: "s",
        message: { role: "assistant", text: "[partial" },
      });
      listener({ type: "run.settled", sessionId: "s", reason: "error", error: "provider failed" });
    });
    expect(await runTurn(session, { text: "task" })).toMatchObject({
      reason: "error",
      text: "[partial",
      error: "provider failed",
    });
  });
  it("bounds a send that never resolves, records failure, and forbids reuse", async () => {
    const tracer = new MemoryTracer();
    const session = handle(() => new Promise(() => {}));
    expect(await runTurn(session, { text: "task" }, { timeoutMs: 10, tracer })).toMatchObject({
      reason: "error",
      error: "turn timed out",
    });
    expect(session.interrupt).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(tracer.find("turn.end")).toHaveLength(1);
    await expect(runTurn(session, { text: "next" })).rejects.toThrow("unusable");
  });
  it("does not dispatch an already-cancelled turn", async () => {
    const send = vi.fn(async () => {});
    const session = handle(send);
    const signal = AbortSignal.abort();
    expect((await runTurn(session, { text: "task" }, { signal })).reason).toBe("aborted");
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects overlapping turns", async () => {
    const session = handle(() => new Promise(() => {}));
    const first = runTurn(session, { text: "a" }, { timeoutMs: 10 });
    await expect(runTurn(session, { text: "b" })).rejects.toThrow("active turn");
    await first;
  });
  it("contains observation failures and reports diagnostics", async () => {
    const diagnostic = vi.fn();
    const adapter = createFakeAdapter();
    expect(
      (
        await runOnce(
          adapter,
          { cwd: "/tmp" },
          { text: "task" },
          {
            tracer: {
              emit: () => {
                throw Error("disk full");
              },
            },
            onDiagnostic: diagnostic,
          },
        )
      ).reason,
    ).toBe("done");
    expect(diagnostic).toHaveBeenCalled();
  });
  it("bounds startup and disposes a late-created session", async () => {
    let resolve!: (session: SessionHandle) => void;
    const session = handle(async () => {});
    const adapter = {
      ...createFakeAdapter(),
      createSession: () =>
        new Promise<SessionHandle>((r) => {
          resolve = r;
        }),
    } satisfies HarnessAdapter;
    await expect(
      openSession(adapter, { cwd: "/tmp" }, undefined, { timeoutMs: 10 }),
    ).rejects.toThrow("creation timed out");
    resolve(session);
    await new Promise((r) => setTimeout(r, 5));
    expect(session.dispose).toHaveBeenCalledOnce();
  });
  it("ignores duplicate terminal events", async () => {
    const tracer = new MemoryTracer();
    const session = handle(async (listener) => {
      listener({ type: "run.settled", sessionId: "s", reason: "done" });
      listener({ type: "run.settled", sessionId: "s", reason: "error" });
    });
    expect((await runTurn(session, { text: "task" }, { tracer })).reason).toBe("done");
    expect(tracer.find("turn.end")).toHaveLength(1);
  });
});
