import { appendFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@mentat/core";
import { describe, expect, it } from "vitest";
import {
  ExperienceStore,
  experienceEvidence,
  messageEvidence,
  SessionRecorder,
  sessionEvidence,
} from "./experience";

describe("SessionRecorder + ExperienceStore", () => {
  it("quarantines a torn tail before the next append without hiding middle corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-exp-torn-"));
    const diagnostics: string[] = [],
      store = new ExperienceStore(dir, { onDiagnostic: (d) => diagnostics.push(d.code) });
    const first = new SessionRecorder({ prompt: "first", cwd: dir, harness: "fake" }).snapshot();
    store.append(first);
    const name = readdirSync(dir).find((x) => x.endsWith(".jsonl"));
    if (!name) throw new Error("missing experience log");
    const path = join(dir, name);
    appendFileSync(path, '{"id":"partial');
    expect(store.list()).toHaveLength(1);
    store.append({ ...first, id: "second" });
    expect(store.list()).toHaveLength(2);
    const torn = readdirSync(dir).find((x) => x.endsWith(".torn"));
    if (!torn) throw new Error("missing quarantined tail");
    expect(readFileSync(join(dir, torn), "utf8")).toBe('{"id":"partial');
    expect(diagnostics).toContain("EXPERIENCE_TORN_TAIL");
    appendFileSync(path, "broken\n");
    expect(() => store.list()).toThrow("corrupt experience");
  });
  it("captures authoritative answers without reasoning and returns isolated snapshots", () => {
    const recorder = new SessionRecorder({ prompt: "task", cwd: "/tmp", harness: "fake" });
    recorder.handle({ type: "message.reasoning", sessionId: "s", text: "private reasoning" });
    recorder.handle({ type: "message.delta", sessionId: "s", text: "partial" });
    recorder.handle({
      type: "message.completed",
      sessionId: "s",
      message: { role: "assistant", text: "final answer" },
    });
    const copy = recorder.snapshot();
    copy.messages?.push({ role: "user", text: "mutation" });
    expect(recorder.snapshot().messages).toEqual([
      { role: "user", index: 0, text: "task" },
      { role: "assistant", index: 1, text: "final answer" },
    ]);
    expect(JSON.stringify(recorder.snapshot())).not.toContain("private reasoning");
  });
  it("records outcome, usage, tools and persists to JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-exp-"));
    const store = new ExperienceStore(dir);
    const recorder = new SessionRecorder({ prompt: "do a thing", cwd: "/tmp", harness: "fake" });

    const events: AgentEvent[] = [
      { type: "run.started", sessionId: "s" },
      { type: "tool.start", sessionId: "s", id: "1", name: "bash", input: {} },
      { type: "tool.result", sessionId: "s", id: "1", output: "boom", isError: true },
      { type: "usage", sessionId: "s", usage: { inputTokens: 10, outputTokens: 5 } },
      { type: "run.settled", sessionId: "s", reason: "done" },
    ];
    for (const event of events) recorder.handle(event);

    const record = recorder.snapshot();
    expect(record.outcome).toBe("done");
    expect(record.toolErrors).toBe(1);
    expect(record.tools).toEqual(["bash"]);
    expect(record.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    store.append(record);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.prompt).toBe("do a thing");
  });

  it("captures the session id and message-level evidence pointers", () => {
    const recorder = new SessionRecorder({ prompt: "t", cwd: "/tmp", harness: "fake" });
    recorder.handle({ type: "run.started", sessionId: "s1" });
    recorder.handle({
      type: "message.completed",
      sessionId: "s1",
      message: { role: "assistant", text: "hi" },
    });
    recorder.handle({
      type: "message.completed",
      sessionId: "s1",
      message: { role: "assistant", text: "bye" },
    });

    const record = recorder.snapshot();
    expect(record.sessionId).toBe("s1");
    expect(record.messages).toEqual([
      { role: "user", index: 0, text: "t" },
      { role: "assistant", index: 1, text: "hi" },
      { role: "assistant", index: 2, text: "bye" },
    ]);
    expect(experienceEvidence(record)).toBe(`exp:${record.id}`);
    expect(messageEvidence(record, 1)).toBe(`exp:${record.id}#msg1`);
    expect(sessionEvidence("s1")).toBe("session:s1");
  });

  it("returns an empty list for a missing directory", () => {
    expect(new ExperienceStore("/nonexistent/mentat-exp-xyz").list()).toEqual([]);
  });

  it("projects final tool parameters and permission outcomes without losing snapshots", () => {
    const recorder = new SessionRecorder({ prompt: "task", cwd: "/tmp", harness: "acp" });
    recorder.handle({ type: "tool.start", sessionId: "s", id: "t", name: "read", input: null });
    const before = recorder.snapshot();
    recorder.handle({
      type: "tool.update",
      sessionId: "s",
      id: "t",
      input: { path: "x" },
      status: "completed",
    });
    recorder.handle({
      type: "tool.result",
      sessionId: "s",
      id: "t",
      output: "part",
      isError: false,
      content: [{ type: "image", data: "opaque" }],
      outputCoverage: "partial",
    });
    recorder.handle({
      type: "permission.request",
      sessionId: "s",
      id: "p",
      toolCallId: "t",
      request: { toolName: "read", input: { path: "x" } },
    });
    recorder.handle({
      type: "permission.resolved",
      sessionId: "s",
      id: "p",
      decision: "deny",
      outcome: "error",
      error: "failed",
    });
    expect(before.toolCalls?.[0]).toMatchObject({ input: null });
    expect(recorder.snapshot().toolCalls).toMatchObject([
      { kind: "call", input: { path: "x" }, status: "completed" },
      { kind: "result", outputCoverage: "partial", content: [{ type: "image", data: "opaque" }] },
    ]);
    expect(recorder.snapshot().permissions).toHaveLength(2);
  });
});
