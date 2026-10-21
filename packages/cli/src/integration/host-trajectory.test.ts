import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter, MemoryTracer } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import {
  createMemoryAccess,
  InMemoryMemoryStore,
  type MemoryRepository,
  MemoryService,
} from "@mentat/memory";
import { inspectTrajectory, readTrajectory, resolveEventData } from "@mentat/observability";
import type { ExperienceRecord } from "@mentat/session";
import { describe, expect, it } from "vitest";
import { traceCommand } from "../commands/trace";

describe("host orchestration and observability", () => {
  it("uses injected memory, trace and experience services", async () => {
    const store = new InMemoryMemoryStore(),
      service = new MemoryService(store);
    const repository: MemoryRepository = {
      async snapshot() {
        return { entries: store.list(), revision: "0" };
      },
      async commit(request) {
        return service.write(request);
      },
    };
    const tracer = new MemoryTracer(),
      records: ExperienceRecord[] = [];
    const host = createAssistantHost(
      { cwd: "/tmp", adapter: createFakeAdapter() },
      {
        memory: createMemoryAccess(repository),
        experience: {
          append: (record) => {
            records.push(record);
          },
        },
        trajectory: tracer,
      },
    );
    const session = await host.open();
    await host.remember("use short answers");
    const { result } = await host.turn(session, "help");
    await host.close();
    expect(result.reason).toBe("done");
    expect(records).toHaveLength(2);
    expect(tracer.types()).toContain("prompt.assembled");
    expect(host.logDir).toBeUndefined();
  });
  it("persists a full task with feedback and validates its trajectory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentat-host-"));
    const host = createAssistantHost({
      cwd,
      adapter: createFakeAdapter(),
      memoryPath: join(cwd, "memory.json"),
    });
    const session = await host.open();
    const { result } = await host.turn(session, "hello");
    host.feedback({ turnId: result.turnId, accepted: true });
    await host.close();
    expect(inspectTrajectory(required(host.logDir))).toMatchObject({
      status: "complete",
      gaps: 0,
      violations: [],
      turns: 1,
    });
    const events = readTrajectory(required(host.logDir));
    const input = required(events.find((e) => e.type === "prompt.assembled"));
    expect(resolveEventData(required(host.logDir), input)).toMatchObject({
      version: "personal-assistant-v12",
      delivery: "undeclared",
    });
    expect(await traceCommand([required(host.logDir), "--check"])).toBe(0);
    expect(
      await traceCommand([
        "feedback",
        required(host.logDir),
        "--turn",
        result.turnId,
        "--score",
        "0.5",
        "--correction",
        "more concise",
      ]),
    ).toBe(0);
    expect(await traceCommand(["compare", required(host.logDir), required(host.logDir)])).toBe(0);
  });
  it("links reflection failures to their parent task without modifying memory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mentat-host-reflect-"));
    const host = createAssistantHost({
      cwd,
      adapter: createFakeAdapter(),
      memoryPath: join(cwd, "memory.json"),
    });
    const session = await host.open();
    const { record } = await host.turn(session, "hello");
    const result = await host.reflect({
      task: "hello",
      outcome: "done",
      tools: [],
      interactions: [record],
    });
    await host.close();
    expect(result.status).toBe("invalid");
    expect(readTrajectory(required(host.logDir)).some((e) => e.type === "reflection.parsed")).toBe(
      true,
    );
    expect(await host.memory.search({})).toEqual([]);
  });
});

it("feeds trace-linked external corrections into the experience digest", async () => {
  const { ExperienceStore, buildExperienceDigest } = await import("@mentat/observability");
  const cwd = mkdtempSync(join(tmpdir(), "mentat-feedback-"));
  const host = createAssistantHost({
    cwd,
    adapter: createFakeAdapter(),
    memoryPath: join(cwd, "memory.json"),
  });
  const session = await host.open();
  const { result } = await host.turn(session, "make a plan");
  await host.close();
  const dir = host.logDir;
  if (!dir) throw Error("missing trace");
  await traceCommand([
    "feedback",
    dir,
    "--turn",
    result.turnId,
    "--score",
    "0",
    "--correction",
    "deadline missed",
  ]);
  const records = new ExperienceStore(join(cwd, ".mentat", "experience")).list();
  expect(records[0]?.feedback).toMatchObject([
    { source: "user", score: 0, correction: "deadline missed" },
  ]);
  expect(buildExperienceDigest(records)).toContain("deadline missed");
  expect(buildExperienceDigest(records)).toContain(host.traceId);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing expected value");
  return value;
}

it("reports ordinary experience failures without changing a completed task into failure", async () => {
  const { InMemoryMemoryStore, MemoryService, createMemoryAccess } = await import("@mentat/memory");
  const store = new InMemoryMemoryStore();
  const service = new MemoryService(store);
  const errors: string[] = [];
  const host = createAssistantHost(
    { cwd: "/tmp", adapter: createFakeAdapter() },
    {
      trajectory: new MemoryTracer(),
      memory: createMemoryAccess({
        async snapshot() {
          return { entries: store.list(), revision: "0" };
        },
        async commit(request) {
          return service.write(request);
        },
      }),
      experience: {
        append() {
          throw Error("disk full");
        },
      },
      onDiagnostic: (d) => errors.push(d.code),
    },
  );
  const session = await host.open();
  expect((await host.turn(session, "hello")).result.reason).toBe("done");
  await host.close();
  expect(errors).toContain("EXPERIENCE_WRITE_FAILED");
});
