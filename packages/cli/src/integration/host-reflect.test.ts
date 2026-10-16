import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reflectMemories } from "@mentat/assistant";
import type { AgentEventListener, HarnessAdapter, SessionOptions } from "@mentat/core";
import { saveReflections } from "@mentat/host";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { SessionRecorder } from "@mentat/observability";
import { describe, expect, it } from "vitest";

describe("full interaction reflection", () => {
  it("passes answers, corrections and failed tools to a separate restricted session", async () => {
    const first = new SessionRecorder({ prompt: "安排周末", cwd: "/tmp", harness: "test" });
    first.handle({
      type: "message.completed",
      sessionId: "s",
      message: { role: "assistant", text: "11:30回家" },
    });
    first.handle({
      type: "tool.start",
      sessionId: "s",
      id: "t",
      name: "calendar",
      input: { day: "Saturday" },
    });
    first.handle({
      type: "tool.result",
      sessionId: "s",
      id: "t",
      output: "unavailable",
      isError: true,
    });
    first.handle({ type: "run.settled", sessionId: "s", reason: "done" });
    const second = new SessionRecorder({
      prompt: "我需要11点前回家",
      input: { text: "我需要11点前回家" },
      cwd: "/tmp",
      harness: "test",
    });
    let listener: AgentEventListener = () => {};
    let input = "";
    let sessionOptions: SessionOptions | undefined;
    let disposed = false;
    const adapter: HarnessAdapter = {
      id: "test",
      capabilities: () => ({
        steer: false,
        compact: false,
        fork: false,
        permissions: true,
        systemPrompt: "replace",
      }),
      createSession: async (options, deps) => {
        sessionOptions = options;
        expect(await deps?.onPermission?.request({ toolName: "bash", input: {} })).toBe("deny");
        return {
          id: "reflection",
          subscribe: (fn) => {
            listener = fn;
            return () => {};
          },
          send: async (message) => {
            input = message.text;
            const batch = JSON.parse(input.match(/Evidence batch: (.*)\n/)?.[1] ?? "{}");
            listener({
              type: "message.completed",
              sessionId: "reflection",
              message: {
                role: "assistant",
                text: JSON.stringify({
                  batchId: batch.batchId,
                  candidates: [
                    {
                      text: "周末11点前回家",
                      kind: "constraint",
                      evidenceRefs: [{ ref: "E2.M1.P1", excerpt: "我需要11点前回家" }],
                    },
                  ],
                }),
              },
            });
            listener({ type: "run.settled", sessionId: "reflection", reason: "done" });
          },
          interrupt: async () => {},
          dispose: async () => {
            disposed = true;
          },
        };
      },
    };
    const result = await reflectMemories(adapter, {
      cwd: "/tmp",
      task: "安排周末",
      outcome: "done",
      tools: ["calendar"],
      interactions: [first.snapshot(), second.snapshot()],
    });
    expect(input).toContain("11:30回家");
    expect(input).toContain("我需要11点前回家");
    expect(input).toContain("unavailable");
    expect(input).toContain("not that the user accepted");
    expect(sessionOptions?.mcpServers).toBeUndefined();
    expect(disposed).toBe(true);
    expect(result.status).toBe("ok");
    const path = join(mkdtempSync(join(tmpdir(), "mentat-reflection-")), "memory.json");
    new JsonFileMemoryStore(path).add({ id: "tool-write", text: "已有事实", createdAt: 0 });
    expect(await saveReflections(path, result.candidates)).toBe(1);
    expect(new JsonFileMemoryStore(path).list()).toHaveLength(2);
    expect(new JsonFileMemoryStore(path).list()[1]?.evidenceIds).toEqual([second.snapshot().id]);
    expect(
      JSON.parse(readFileSync(`${path}.audit.jsonl`, "utf8").trim()).entry.evidenceIds,
    ).toEqual([second.snapshot().id]);
    expect(new JsonFileMemoryStore(path).list()[1]).toMatchObject({
      status: "candidate",
      basis: "inference",
      speaker: "assistant",
      kind: "constraint",
      evidence: `exp:${second.snapshot().id}#msg0/part0`,
      evidenceSources: [{ origin: "user", excerpt: "我需要11点前回家" }],
    });
    expect(await saveReflections(path, result.candidates)).toBe(0);
  });
});
