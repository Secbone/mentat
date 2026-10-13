import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { commandGate } from "./command-gate";

const cwd = mkdtempSync(join(tmpdir(), "mentat-cmd-"));
const candidate: Candidate = { id: "x", version: "x", artifacts: [] };

describe("commandGate", () => {
  it("passes when the command exits 0", async () => {
    const gate = commandGate("ok", { cwd, command: "node", args: ["-e", "process.exit(0)"] });
    expect((await gate.check(candidate)).passed).toBe(true);
  });

  it("fails with a reason when the command exits nonzero", async () => {
    const gate = commandGate("bad", {
      cwd,
      command: "node",
      args: ["-e", "console.error('boom'); process.exit(2)"],
    });
    const result = await gate.check(candidate);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("boom");
  });
});
