import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "@mentat/evolution";
import { describe, expect, it } from "vitest";
import { commandGate, runCommand } from "./command-gate";

const cwd = mkdtempSync(join(tmpdir(), "mentat-cmd-"));
const candidate: Candidate = { id: "x", version: "x", artifacts: [] };

describe("commandGate", () => {
  it("kills descendants on timeout and does not leave delayed state changes", async () => {
    const marker = join(cwd, "orphan-marker");
    const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),600)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const result = await runCommand({
      cwd,
      command: process.execPath,
      args: ["-e", parent],
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps successful execution successful when tracing fails", async () => {
    const result = await runCommand({
      cwd,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      tracer: {
        emit() {
          throw new Error("disk full");
        },
      },
    });
    expect(result.ok).toBe(true);
  });
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
