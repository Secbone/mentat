import { mkdtempSync } from "node:fs";
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
      { role: "assistant", index: 0, text: "hi" },
      { role: "assistant", index: 1, text: "bye" },
    ]);
    expect(experienceEvidence(record)).toBe(`exp:${record.id}`);
    expect(messageEvidence(record, 1)).toBe(`exp:${record.id}#msg1`);
    expect(sessionEvidence("s1")).toBe("session:s1");
  });

  it("returns an empty list for a missing directory", () => {
    expect(new ExperienceStore("/nonexistent/mentat-exp-xyz").list()).toEqual([]);
  });
});
