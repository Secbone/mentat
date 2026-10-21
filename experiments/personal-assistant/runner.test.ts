import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, AgentEventListener, SessionHandle } from "@mentat/core";
import { acpPermission, lexicalDiagnostic, parentCheckpoint, sendTurn, taskInput } from "./runner";

test("MCP gateway stays discoverable while unrelated built-in actions are denied", () => {
  const permission = acpPermission("C");
  assert.equal(permission["*"], "ask");
  assert.equal(permission.execute, undefined);
  for (const tool of ["read", "bash", "edit", "write", "task"])
    assert.equal(permission[tool], "deny");
  assert.equal(permission["memory_*"], "allow");
  assert.equal(acpPermission("A")["*"], "deny");
});

test("probe tasks inherit frozen learning checkpoints", () => {
  assert.equal(parentCheckpoint("01"), undefined);
  assert.equal(parentCheckpoint("03"), "02");
  for (const id of ["05", "06", "07"]) assert.equal(parentCheckpoint(id), "04");
  for (const id of ["08", "09"]) assert.equal(parentCheckpoint(id), "07");
  assert.equal(parentCheckpoint("10"), "09");
});

test("agent input cannot include hidden profile, future tasks or score", () => {
  const scenario = {
    name: "测试用户",
    role: "测试职业",
    evaluatorProfile: "SECRET",
    future: "FUTURE",
  };
  const input = taskInput(scenario, {
    id: "01",
    phase: "learn",
    simulatedDay: 2,
    input: { prompt: "TASK", source: "SOURCE" },
    afterResponseFeedback: "FEEDBACK_NOT_YET_VISIBLE",
  });
  assert(input.includes("TASK") && input.includes("SOURCE"));
  for (const forbidden of ["SECRET", "FUTURE", "FEEDBACK_NOT_YET_VISIBLE"]) {
    assert(!input.includes(forbidden));
  }
});

function session(send: (emit: (event: AgentEvent) => void) => Promise<void>): SessionHandle {
  const listeners = new Set<AgentEventListener>();
  return {
    id: "test",
    send: () =>
      send((event) => {
        for (const listener of listeners) listener(event);
      }),
    interrupt: async () => {},
    dispose: async () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

test("captures answer emitted synchronously and does not confuse reasoning with output", async () => {
  const handle = session(async (emit) => {
    emit({ type: "message.reasoning", sessionId: "test", text: "private thinking" });
    emit({ type: "message.delta", sessionId: "test", text: "answer" });
    emit({
      type: "message.completed",
      sessionId: "test",
      message: { role: "assistant", text: "answer" },
    });
    emit({ type: "run.settled", sessionId: "test", reason: "done" });
  });
  const result = await sendTurn(handle, "prompt", 100);
  assert.equal(result.reason, "done");
  assert.equal(result.text, "answer");
});

test("empty settled output is an execution failure, not a successful business answer", async () => {
  const handle = session(async (emit) =>
    emit({ type: "run.settled", sessionId: "test", reason: "done" }),
  );
  assert.equal((await sendTurn(handle, "prompt", 100)).reason, "error");
});

test("hung engines time out", async () => {
  const handle = session(async () => {});
  const result = await sendTurn(handle, "prompt", 10);
  assert.equal(result.reason, "error");
  assert.match(result.error ?? "", /timed out|timeout/);
});

test("Chinese paraphrase retrieval failure is observable independently of model quality", () => {
  const entry = {
    id: "preference",
    text: "内部决策先一句话建议，再列证据、风险和下一步",
    createdAt: 0,
  };
  assert.equal(lexicalDiagnostic([entry], "评估客服工单自动分类方案。").retrieved.length, 0);
  assert.equal(lexicalDiagnostic([entry], entry.text).retrieved.length, 1);
});
