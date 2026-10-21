import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { ExperienceStore } from "@mentat/observability";
import { afterEach, expect, it, vi } from "vitest";
import { printResult, runCommand } from "./run";

const state = vi.hoisted(() => ({
  adapter: undefined as ReturnType<typeof createFakeAdapter> | undefined,
}));
vi.mock("../lib/registry", () => ({
  createDefaultRegistry: () => ({ has: () => true, get: () => state.adapter }),
}));
afterEach(() => vi.restoreAllMocks());

it("prints budget-limited partial output with an explicit execution notice", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  printResult({
    turnId: "t",
    sessionId: "s",
    reason: "length",
    text: "partial result",
    events: [],
    durationMs: 1,
    termination: { source: "acp", cause: "request-limit", rawReason: "max_turn_requests" },
  });
  expect(stdout).toHaveBeenCalledWith("partial result\n");
  expect(stderr).toHaveBeenCalledWith("[execution stopped: request-limit]\n");
});

it("warns about self-reported limits without labeling a normal stop as verified success", () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  printResult({
    turnId: "t",
    sessionId: "s",
    reason: "done",
    text: "response",
    events: [],
    durationMs: 1,
    completion: {
      response: "present",
      verification: "unverified",
      warnings: [{ source: "assistant", code: "assistant-reported-step-limit", text: "limit" }],
    },
  });
  expect(stderr).toHaveBeenCalledWith(
    "[assistant reports a step limit; task completion is unverified]\n",
  );
});

it("does not send a task to the harness when required constraints exceed the budget", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const dir = mkdtempSync(join(tmpdir(), "mentat-run-budget-"));
  const path = join(dir, "memory.json");
  const experience = join(dir, "experience");
  new JsonFileMemoryStore(path).add({
    id: "deadline",
    text: "11点前回家".repeat(2000),
    kind: "constraint",
    createdAt: 1,
  });
  const fake = createFakeAdapter();
  const create = fake.createSession.bind(fake);
  const send = vi.fn();
  const dispose = vi.fn();
  vi.spyOn(fake, "createSession").mockImplementation(async (options, deps) => {
    const session = await create(options, deps);
    const originalDispose = session.dispose.bind(session);
    session.send = send;
    session.dispose = async () => {
      dispose();
      await originalDispose();
    };
    return session;
  });
  state.adapter = fake;
  expect(await runCommand(["--memory", path, "--experience", experience, "安排周末"])).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(stderr.mock.calls.map((call) => call[0]).join("")).toContain("required constraints");
  expect(new ExperienceStore(experience).list()[0]?.outcome).toBe("error");
});
