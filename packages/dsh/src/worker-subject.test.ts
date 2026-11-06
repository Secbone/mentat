import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrialUnit } from "@mentat/benchmark";
import { defineCapabilityPack } from "@mentat/pack";
import type { WorkerAdapter, WorkerTask } from "@mentat/worker";
import { describe, expect, it } from "vitest";
import { workerSubjectFactory } from "./worker-subject";

const unit: TrialUnit = {
  caseId: "echo",
  familyId: "echo",
  arm: "explicit",
  repetition: 0,
  sourceId: "echo",
  metricIds: [],
};

function worker(tasks: WorkerTask[]): WorkerAdapter {
  return {
    id: "fake",
    capabilities: () => ({
      promptInjection: "system",
      skills: "none",
      mcp: false,
      permissions: "none",
      streaming: true,
      costReporting: true,
      steer: false,
      fork: false,
    }),
    async spawn(task) {
      tasks.push(task);
      return {
        id: `session-${tasks.length}`,
        async send() {},
        async *events() {
          yield {
            type: "usage",
            at: "2026-11-06T00:00:00.000Z",
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.01,
          };
        },
        async cancel() {},
        async report() {
          return { kind: "ready", summary: "ok", text: `echo:${task.prompt}` };
        },
        async dispose() {},
      };
    },
  };
}

const pack = defineCapabilityPack({
  id: "worker",
  version: 1,
  prompt: { system: "be exact", role: "worker" },
});

describe("workerSubjectFactory", () => {
  it("runs turns through the worker and replays explicit memory", async () => {
    const tasks: WorkerTask[] = [];
    const out = mkdtempSync(join(tmpdir(), "mentat-worker-subject-"));
    const createSubject = workerSubjectFactory({ worker: worker(tasks), cwd: out, out });
    const subject = await createSubject(pack)({ stateKey: "state", unit, memory: "explicit" });
    const first = await subject.turn({ text: "hello" });
    expect(first.text).toBe("echo:hello");
    expect(first.costUsd).toBe(0.01);
    expect(tasks[0]?.pack.digest).toBe(pack.digest);
    const evidence = first.evidence[0];
    expect(evidence).toBeDefined();
    expect(JSON.parse(readFileSync(evidence as string, "utf8")).report.text).toBe("echo:hello");
    await subject.remember({ text: "the passphrase is pong", kind: "fact" });
    const second = await subject.turn({ text: "again" });
    expect(tasks[1]?.prompt).toContain("the passphrase is pong");
    expect(second.text).toContain("the passphrase is pong");
  });
});
