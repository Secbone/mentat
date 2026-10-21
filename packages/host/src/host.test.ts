import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { describe, expect, it, vi } from "vitest";
import {
  readRepoState,
  resolveHostPaths,
  resolveMemoryTools,
  validateServerNames,
  validateStartupToolProbe,
} from "./config";
import { createAssistantHost } from "./host";
import { withNoEvidencePolicy } from "./policy";

describe("host config helpers", () => {
  it("routes through an injected model policy without overriding an explicit model", () => {
    const config = { cwd: "/tmp", adapter: createFakeAdapter(), memoryPath: "/tmp/memory.json" };
    const overrides = { modelSelector: { select: () => ({ id: "selected-model" }) } };
    expect(resolveHostPaths(config, overrides).model).toBe("selected-model");
    expect(resolveHostPaths({ ...config, model: "explicit" }, overrides).model).toBe("explicit");
    expect(() => resolveHostPaths(config, { modelSelector: { select: () => undefined } })).toThrow(
      "no model satisfies",
    );
  });
  it("validates the startup tool probe shape", () => {
    expect(() => validateStartupToolProbe(undefined)).not.toThrow();
    expect(() =>
      validateStartupToolProbe({ toolName: "t", expectedOutput: "e", maxAttempts: 4 }),
    ).toThrow("invalid startup tool probe");
    expect(() => validateStartupToolProbe({ toolName: "", expectedOutput: "e" })).toThrow(
      "invalid startup tool probe",
    );
  });

  it("defaults memory tools off under a deny permission mode", () => {
    expect(
      resolveMemoryTools({ cwd: "/tmp", adapter: createFakeAdapter(), permissionMode: "deny" }),
    ).toMatchObject({ memoryTools: { memory: "disabled" }, registerMemory: false });
  });

  it("rejects duplicate or unnamed MCP servers", () => {
    expect(() => validateServerNames(false, [{ name: "a", command: "x", args: [] }])).not.toThrow();
    expect(() =>
      validateServerNames(false, [
        { name: "a", command: "x", args: [] },
        { name: "a", command: "y", args: [] },
      ]),
    ).toThrow("duplicate or empty MCP server name");
  });

  it("requires a memory implementation or path", () => {
    expect(() => resolveHostPaths({ cwd: "/tmp", adapter: createFakeAdapter() }, {})).toThrow(
      "memory",
    );
  });

  it("reports an unknown revision outside a git repository", () => {
    expect(readRepoState(tmpdir()).revision).toBe("unknown");
  });

  it("merges the no-evidence policy without dropping caller policy", () => {
    const merged = withNoEvidencePolicy({ text: "q", hostPolicy: "existing policy" });
    expect(merged.hostPolicy).toContain("existing policy");
    expect(merged.hostPolicy).toContain("No historical reference matched");
  });
});

describe("createAssistantHost", () => {
  it("cancels reflection reads and joins concurrent close calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-reflection-close-"));
    let searching = false;
    const host = createAssistantHost(
      { cwd: root, adapter: createFakeAdapter() },
      {
        trajectory: { emit() {} },
        experience: { append() {} },
        memory: {
          search: () => {
            searching = true;
            return new Promise(() => {});
          },
          context: () => new Promise(() => {}),
          propose: async () => ({ op: "reject" }),
          confirm: async () => ({ op: "reject" }),
        },
      },
    );
    const reflection = host.reflect({
      task: "reflect",
      outcome: "done",
      tools: [],
      interactions: [],
    });
    const rejected = expect(reflection).rejects.toThrow("cancelled before dispatch");
    await vi.waitFor(() => expect(searching).toBe(true));
    await Promise.all([host.close(), host.close()]);
    await rejected;
    rmSync(root, { recursive: true, force: true });
  });
  it("cancels a pending recall and drains its turn before closing the trace", async () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-host-close-"));
    const events: string[] = [];
    let recalling = false;
    const host = createAssistantHost(
      { cwd: root, adapter: createFakeAdapter() },
      {
        trajectory: {
          emit: (type) => {
            events.push(type);
          },
        },
        experience: { append() {} },
        memory: {
          search: async () => [],
          context: () => {
            recalling = true;
            return new Promise(() => {});
          },
          propose: async () => ({ op: "reject" }),
          confirm: async () => ({ op: "reject" }),
        },
      },
    );
    const session = await host.open(),
      send = vi.spyOn(session, "send");
    const turn = host.turn(session, "task");
    const rejected = expect(turn).rejects.toThrow("cancelled before dispatch");
    await vi.waitFor(() => expect(recalling).toBe(true));
    await host.close();
    await rejected;
    expect(send).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("task.end");
    rmSync(root, { recursive: true, force: true });
  });
  it("inherits the host turn deadline and rejects writes after close", async () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-host-timeout-"));
    const adapter = createFakeAdapter();
    const create = adapter.createSession.bind(adapter);
    vi.spyOn(adapter, "createSession").mockImplementation(async (opts, deps) => {
      const session = await create(opts, deps);
      session.send = () => new Promise(() => {});
      return session;
    });
    const host = createAssistantHost({
      cwd: root,
      adapter,
      timeoutMs: 100,
      memoryPath: join(root, "memory.json"),
    });
    try {
      const session = await host.open();
      const { result } = await host.turn(session, "deadline");
      expect(result.reason).toBe("error");
      expect(result.error).toContain("timed out");
      await host.close();
      await expect(host.remember("late write")).rejects.toThrow("closed");
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks oversized assembled context before dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-host-budget-"));
    const adapter = createFakeAdapter();
    const host = createAssistantHost({
      cwd: root,
      adapter,
      memoryPath: join(root, "memory.json"),
      contextBudget: { maxInputChars: 100 },
    });
    try {
      const session = await host.open(),
        send = vi.spyOn(session, "send");
      await expect(
        host.turn(session, { text: "task", materials: [{ text: "x".repeat(1000) }] }),
      ).rejects.toThrow("assembled input exceeds");
      expect(send).not.toHaveBeenCalled();
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("opens, runs a turn and closes with a file-backed memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-host-"));
    const host = createAssistantHost({
      cwd: root,
      adapter: createFakeAdapter(),
      memoryPath: join(root, "memory.json"),
      experienceDir: join(root, "experience"),
      permissionMode: "deny",
      permission: { request: () => "deny" },
    });
    try {
      const session = await host.open();
      const { result } = await host.turn(session, "hello");
      expect(result.reason).toBe("done");
      expect(result.text).toContain("hello");
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
