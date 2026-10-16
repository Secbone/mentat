import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEventListener, HarnessAdapter, UserInput } from "@mentat/core";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { ExperienceStore } from "@mentat/observability";
import { afterEach, expect, it, vi } from "vitest";
import { chatCommand } from "./chat";

const state = vi.hoisted(() => ({
  lines: [] as string[],
  adapter: undefined as HarnessAdapter | undefined,
}));
vi.mock("node:readline/promises", () => ({
  createInterface: () => {
    const rl = new EventEmitter() as EventEmitter & { close(): void };
    rl.close = () => rl.emit("close");
    queueMicrotask(() => {
      for (const line of state.lines) rl.emit("line", line);
    });
    return rl;
  },
}));
vi.mock("../lib/registry", () => ({
  createDefaultRegistry: () => ({ has: () => true, get: () => state.adapter }),
}));
afterEach(() => vi.restoreAllMocks());

it("reflects chat corrections with earlier answers and reloads tool-written memory next turn", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const dir = mkdtempSync(join(tmpdir(), "mentat-chat-"));
  const memory = join(dir, "memory.json");
  const sends: UserInput[] = [];
  const reflectionEvidence: Array<{ records: unknown[]; sources: unknown[] }> = [];
  let disposed = 0;
  state.lines = [
    "安排周末",
    "需要11点前回家",
    "/reflect",
    "/reflect",
    "保持20分钟交通缓冲",
    "/reflect",
    "/exit",
  ];
  state.adapter = {
    id: "test",
    capabilities: () => ({
      steer: false,
      compact: false,
      fork: false,
      permissions: true,
      systemPrompt: "replace",
    }),
    createSession: async (options) => {
      let listener: AgentEventListener = () => {};
      const reflection = options.systemPrompt?.startsWith("Extract memories");
      return {
        id: "s",
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
        send: async (input) => {
          let answer: string;
          if (reflection) {
            const evidence = JSON.parse(input.text.match(/Evidence batch: (.*)\n/)?.[1] ?? "{}");
            reflectionEvidence.push(evidence);
            answer = JSON.stringify({
              batchId: evidence.batchId,
              candidates: [
                {
                  text: "11点前回家",
                  kind: "constraint",
                  evidenceRefs: [{ ref: "E2.M1.P1", excerpt: "需要11点前回家" }],
                },
              ],
            });
          } else {
            sends.push(input);
            answer = sends.length === 1 ? "安排到11:30" : "已修订计划";
            if (sends.length === 1)
              new JsonFileMemoryStore(memory).add({
                id: "mcp",
                text: "交通缓冲20分钟",
                createdAt: 1,
              });
          }
          listener({
            type: "message.completed",
            sessionId: "s",
            message: { role: "assistant", text: answer },
          });
          listener({ type: "run.settled", sessionId: "s", reason: "done" });
        },
        interrupt: async () => {},
        dispose: async () => {
          disposed += 1;
        },
      };
    },
  };
  expect(
    await chatCommand([
      "--harness",
      "test",
      "--memory",
      memory,
      "--experience",
      join(dir, "experience"),
    ]),
  ).toBe(0);
  expect(sends[1]?.context).toContain("交通缓冲20分钟");
  expect(sends[2]?.context).not.toContain("11点前回家");
  expect(reflectionEvidence.map((batch) => batch.records.length)).toEqual([2, 3]);
  expect(JSON.stringify(reflectionEvidence[1])).toContain("安排到11:30");
  expect(new JsonFileMemoryStore(memory).list()).toHaveLength(2);
  expect(
    new JsonFileMemoryStore(memory).list().find((entry) => entry.text === "11点前回家"),
  ).toMatchObject({ status: "candidate", basis: "inference", speaker: "assistant" });
  expect(new ExperienceStore(join(dir, "experience")).list()).toHaveLength(3);
  expect(disposed).toBe(3);
});
