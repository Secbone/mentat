import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { ExperienceStore, SessionRecorder } from "./experience";

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

  it("returns an empty list for a missing directory", () => {
    expect(new ExperienceStore("/nonexistent/mentat-exp-xyz").list()).toEqual([]);
  });
});
