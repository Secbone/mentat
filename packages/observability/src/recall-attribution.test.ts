import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonValue, renderTurnInput } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { recallAttribution, recallSelection } from "./recall-attribution";
import { FileTrajectoryStore } from "./trajectory";

const create = () =>
  new FileTrajectoryStore(join(mkdtempSync(join(tmpdir(), "mentat-recall-")), "trace"));
const emit = (store: FileTrajectoryStore, type: string, data: unknown) =>
  store.emit(type, data as JsonValue);
const text = JSON.stringify({
  pointer: "exp-a#msg0:0",
  role: "user",
  scope: "alice",
  date: "2026-01-01",
  sourceMemoryScope: "task",
  content: "Use this exception for this task only.",
});

async function contextCase(
  options: {
    wire?: boolean;
    changed?: boolean;
    blocked?: boolean;
    wrongConnection?: boolean;
    empty?: boolean;
  } = {},
) {
  const store = create();
  emit(store, "recall.policy", { reads: {}, actionEffects: { publish: "write" } });
  emit(store, "session.create.end", { sessionId: "host-a", spanId: "connection-a" });
  const selected = options.empty ? "" : text;
  const selection = recallSelection({
    turnId: "t",
    recallId: "r",
    kind: "native-history",
    contextName: "quoted-material-1",
    text: selected,
    selectedIds: selected ? ["exp-a#msg0:0"] : [],
    blocked: options.blocked,
  });
  emit(store, "recall.selection", selection);
  emit(store, "prompt.assembled", {
    turnId: "t",
    contexts: [{ name: "quoted-material-1", text: selected }],
  });
  if (options.blocked) emit(store, "recall.blocked", { turnId: "t" });
  else {
    const input = {
      text: "Publish the requested draft.",
      context: JSON.stringify({
        name: "quoted-material-1",
        text: options.changed ? "different source" : selected,
      }),
    };
    emit(store, "turn.start", { turnId: "t", sessionId: "host-a", input });
    if (options.wire !== false)
      emit(store, "adapter.protocol", {
        connectionId: options.wrongConnection ? "other" : "connection-a",
        direction: "out",
        data: {
          method: "session/prompt",
          params: { prompt: [{ type: "text", text: renderTurnInput(input) }] },
        },
      });
    emit(store, "agent.event", { turnId: "t", type: "tool.start", id: "write", name: "publish" });
    emit(store, "turn.end", { turnId: "t" });
  }
  await store.close();
  return recallAttribution(store.dir);
}

describe("recall attribution", () => {
  it("links original-source metadata to assembly, actual request and later action without activating it", async () => {
    const report = await contextCase();
    expect(report.status).toBe("observed");
    expect(report.evidence[0]).toMatchObject({
      kind: "native-history",
      outcome: "hit",
      delivery: "captured-request",
      beforeFirstWrite: true,
      sources: [{ id: "exp-a#msg0:0", role: "user", memoryScope: "task", scope: "alice" }],
    });
    expect(report.evidence[0]?.sources[0]).not.toHaveProperty("state", "active");
    expect(report.byKind["native-history"]?.capturedContextInjections).toBe(1);
    expect(report.byKind.memory?.capturedContextInjections).toBe(0);
  });

  it("does not equate host input, a different connection, empty selection or blocked assembly to injection", async () => {
    for (const options of [
      { wire: false },
      { wrongConnection: true },
      { empty: true },
      { blocked: true },
    ]) {
      const report = await contextCase(options);
      expect(report.byKind["native-history"]?.capturedContextInjections).toBe(0);
      expect(report.evidence[0]?.beforeFirstWrite).toBeNull();
    }
  });

  it("rejects selected content that was replaced before sending", async () => {
    const report = await contextCase({ changed: true });
    expect(report.status).toBe("issues");
    expect(report.evidence[0]?.hostInputMatched).toBe(false);
    expect(report.byKind["native-history"]?.capturedContextInjections).toBe(0);
  });

  it("distinguishes empty, failed, incomplete, partial and candidate tool reads from a successful procedure read", async () => {
    const store = create();
    emit(store, "recall.policy", {
      reads: { lookup: "memory", open: "procedure", list: "procedure-catalog" },
      actionEffects: { read_record: "read", update_record: "write" },
    });
    emit(store, "turn.start", { turnId: "t", input: { text: "Do the task." } });
    const call = (
      id: string,
      name: string,
      output?: string,
      isError = false,
      outputCoverage?: string,
    ) => {
      emit(store, "agent.event", { turnId: "t", type: "tool.start", id, name });
      if (output !== undefined)
        emit(store, "agent.event", {
          turnId: "t",
          type: "tool.result",
          id,
          output,
          isError,
          ...(outputCoverage ? { outputCoverage } : {}),
        });
    };
    call("empty", "lookup", "[]");
    call("failed", "lookup", "network failed", true);
    call("pending", "lookup");
    call("partial", "lookup", "[]", false, "partial");
    call(
      "candidate",
      "lookup",
      JSON.stringify([{ id: "candidate-a", status: "candidate", revision: 3, text: "unverified" }]),
    );
    call("catalog", "list", JSON.stringify([{ name: "workflow", version: 2 }]));
    call(
      "procedure",
      "open",
      JSON.stringify({ name: "workflow", version: 2, content: "Verified steps", scope: "alice" }),
    );
    call("write", "update_record", "ok");
    call(
      "late",
      "open",
      JSON.stringify({ name: "workflow", version: 2, content: "Verified steps" }),
    );
    await store.close();
    const report = recallAttribution(store.dir);
    expect(report.byKind.memory).toMatchObject({
      attempts: 5,
      hits: 1,
      empty: 1,
      failed: 1,
      incomplete: 1,
      unparsed: 1,
      successfulToolReads: 3,
    });
    expect(report.evidence.find((item) => item.recallId === "candidate")?.sources[0]).toMatchObject(
      { state: "candidate", version: 3 },
    );
    expect(report.evidence.find((item) => item.recallId === "procedure")?.beforeFirstWrite).toBe(
      true,
    );
    expect(report.evidence.find((item) => item.recallId === "late")?.beforeFirstWrite).toBe(false);
    expect(report.byKind.procedure?.hits).toBe(2);
    expect(report.byKind["procedure-catalog"]?.hits).toBe(1);
  });

  it("keeps action timing unknown when an unclassified action precedes a tool read", async () => {
    const store = create();
    emit(store, "recall.policy", {
      reads: { lookup: "memory" },
      actionEffects: { publish: "write" },
    });
    emit(store, "turn.start", { turnId: "t", input: { text: "Do the task." } });
    emit(store, "agent.event", {
      turnId: "t",
      type: "tool.start",
      id: "unknown",
      name: "custom_operation",
    });
    emit(store, "agent.event", { turnId: "t", type: "tool.start", id: "read", name: "lookup" });
    emit(store, "agent.event", {
      turnId: "t",
      type: "tool.result",
      id: "read",
      output: '[{"id":"a","text":"source"}]',
      isError: false,
    });
    emit(store, "agent.event", { turnId: "t", type: "tool.start", id: "write", name: "publish" });
    await store.close();
    expect(recallAttribution(store.dir).evidence[0]).toMatchObject({
      beforeFirstWrite: null,
      unknownActionTools: ["custom_operation"],
    });
  });

  it("reports interrupted selections and retrieval errors without creating successful injections", async () => {
    const store = create();
    emit(store, "recall.start", { turnId: "t", recallId: "pending", kind: "native-history" });
    emit(store, "recall.error", {
      turnId: "t",
      recallId: "failed",
      kind: "memory",
      error: "read failed",
    });
    await store.close();
    const report = recallAttribution(store.dir);
    expect(report.byKind["native-history"]?.incomplete).toBe(1);
    expect(report.byKind.memory?.failed).toBe(1);
    expect(report.byKind.memory?.capturedContextInjections).toBe(0);
  });

  it("does not fabricate attribution for legacy selection counters", async () => {
    const store = create();
    emit(store, "context.selection", { selectedIds: ["a"] });
    await store.close();
    expect(recallAttribution(store.dir)).toMatchObject({ status: "unavailable", evidence: [] });
  });
});
