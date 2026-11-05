import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  AgentEventListener,
  HarnessAdapter,
  SessionHandle,
  SessionOptions,
} from "@mentat/core";
import { defineCapabilityPack } from "@mentat/pack";
import { FileRepositories } from "@mentat/store";
import { HarnessWorker } from "@mentat/worker";
import { describe, expect, it } from "vitest";
import type { ReceiptSink, RouterAgentPort, RuntimeReceipt } from "./runtime";
import { createMentatService } from "./service";

function fakeHarness(captured: SessionOptions[] = []): HarnessAdapter {
  return {
    id: "fake-harness",
    capabilities: () => ({
      steer: false,
      compact: false,
      fork: false,
      permissions: false,
      systemPrompt: "replace",
    }),
    async createSession(options): Promise<SessionHandle> {
      captured.push(options);
      const listeners = new Set<AgentEventListener>();
      const emit = (event: AgentEvent) => {
        for (const listener of listeners) listener(event);
      };
      return {
        id: "worker-session",
        async send() {
          emit({ type: "run.started", sessionId: "worker-session" });
          emit({ type: "message.delta", sessionId: "worker-session", text: "done" });
          emit({
            type: "message.completed",
            sessionId: "worker-session",
            message: { role: "assistant", text: "done" },
          });
          emit({ type: "run.settled", sessionId: "worker-session", reason: "done" });
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

function memorySink(): ReceiptSink & { receipts: RuntimeReceipt[] } {
  const receipts: RuntimeReceipt[] = [];
  return {
    receipts,
    append(receipt) {
      receipts.push(receipt);
    },
  };
}

function router(): RouterAgentPort & { created: string[]; disposed: string[] } {
  const created: string[] = [];
  const disposed: string[] = [];
  return {
    created,
    disposed,
    async create(options) {
      created.push(options.sessionId);
      return { sessionId: options.sessionId };
    },
    async dispose(sessionId) {
      disposed.push(sessionId);
    },
  };
}

describe("MentatRuntime vertical slice", () => {
  it("starts a Router, dispatches through HarnessWorker, persists and records a receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-runtime-"));
    const agents = router();
    const receipts = memorySink();
    const captured: SessionOptions[] = [];
    const pack = defineCapabilityPack({
      id: "test-pack",
      version: 2,
      prompt: { system: "pack prompt", role: "worker" },
      model: { model: "pack/model" },
    });
    const service = createMentatService({
      dir,
      agents,
      receipts,
      pack,
      worker: new HarnessWorker(fakeHarness(captured)),
    });

    const routerSession = await service.runtime.startRouter();
    expect(routerSession).toBeTruthy();
    expect(agents.created).toEqual([routerSession]);

    service.runtime.receive({
      id: "t1",
      source: "local",
      thread: "thread-1",
      actor: "local-user",
      bot: false,
      addressed: "mention",
      text: "fix the failing test",
      at: "2026-11-05T00:00:00.000Z",
      meta: { scope: "local" },
    });
    await service.runtime.evaluate();
    const decision = await service.runtime.dispatch("t1");

    expect(decision.outcome).toBe("accept");
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.receipts[0]).toMatchObject({
      routerSession,
      trigger: "t1",
      worker: "fake-harness",
      outcome: "completed",
      pack: { id: "test-pack", version: 2, digest: pack.digest },
      report: { kind: "ready", text: "done" },
    });
    expect(captured[0]).toMatchObject({
      systemPrompt: "pack prompt",
      model: "pack/model",
    });
    const ticket = service.repos.tickets.list()[0];
    expect(ticket).toBeDefined();
    const assignment = service.repos.assignments.get(ticket?.assignments[0] ?? "");
    expect(assignment).toMatchObject({ state: "ended" });
    expect(assignment?.packDigest).toBe(pack.digest);

    const reloaded = new FileRepositories(join(dir, "state"));
    expect(reloaded.tickets.list()).toHaveLength(1);
    expect(reloaded.assignments.list()[0]?.state).toBe("ended");

    await service.runtime.dispose();
    expect(agents.disposed).toEqual([routerSession]);
  });
});
