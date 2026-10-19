import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { describe, expect, it } from "vitest";
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
