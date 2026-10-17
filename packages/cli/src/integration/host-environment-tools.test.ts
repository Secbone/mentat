import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter, type SessionOptions } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import { expect, it } from "vitest";

it("does not register memory tools or advertise search in a closed-book host", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-closed-book-"));
  const base = createFakeAdapter();
  let seen: SessionOptions | undefined;
  const host = createAssistantHost({
    cwd: root,
    memoryPath: join(root, "memory.json"),
    permissionMode: "deny",
    memoryTools: { memory: "disabled" },
    adapter: {
      ...base,
      createSession: async (options, deps) => {
        seen = options;
        return base.createSession(options, deps);
      },
    },
  });
  try {
    await host.open();
    expect(seen?.mcpServers).toBeUndefined();
    expect(seen?.systemPrompt).toContain("Memory tools are unavailable");
    expect(seen?.systemPrompt).not.toContain("memory_search");
  } finally {
    await host.close();
  }
});

it("passes task MCP servers alongside memory without granting tool permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-task-tools-"));
  const base = createFakeAdapter();
  let seen: SessionOptions | undefined;
  const host = createAssistantHost({
    cwd: root,
    memoryPath: join(root, "memory.json"),
    mcpServers: [
      {
        name: "environment",
        command: "task-tool-server",
        args: ["--sealed"],
        env: { TASK: "fixture" },
      },
    ],
    adapter: {
      ...base,
      async createSession(options, deps) {
        seen = structuredClone(options);
        return base.createSession(options, deps);
      },
    },
    permission: { request: () => "deny" },
  });
  try {
    await host.open();
  } finally {
    await host.close();
  }
  expect(seen?.mcpServers?.map((s) => s.name)).toEqual(["memory", "environment"]);
  expect(seen?.mcpServers?.[1]).toEqual({
    name: "environment",
    command: "task-tool-server",
    args: ["--sealed"],
    env: { TASK: "fixture" },
  });
  expect(() =>
    createAssistantHost({
      cwd: root,
      adapter: base,
      memoryPath: join(root, "memory.json"),
      mcpServers: [{ name: "memory", command: "shadow-memory" }],
    }),
  ).toThrow("duplicate");
});
