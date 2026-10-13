import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Proposal, type Proposer, SelfIterationLoop } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { commandGate } from "./command-gate";
import { CheckEvaluator } from "./evaluators";
import { GitWorkspace } from "./git-workspace";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mentat-smoke-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@test"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "value.txt"), "0\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  return dir;
}

/** A deterministic stand-in for an agent: writes value.txt then lets apply commit. */
class FileProposer implements Proposer {
  private index = 0;
  constructor(
    private readonly cwd: string,
    private readonly writes: string[],
  ) {}

  async propose(): Promise<Proposal> {
    const value = this.writes[this.index] ?? "0";
    this.index += 1;
    writeFileSync(join(this.cwd, "value.txt"), `${value}\n`);
    return { id: `p${this.index}`, description: `set value to ${value}` };
  }
}

const CHECK =
  "node -e \"process.exit(Number(require('fs').readFileSync('value.txt','utf8'))>=1?0:1)\"";

describe("self-iteration loop over a real git workspace", () => {
  it("commits an improvement and rolls back a gate failure", async () => {
    const dir = makeRepo();
    const loop = new SelfIterationLoop({
      workspace: new GitWorkspace(dir),
      proposer: new FileProposer(dir, ["1", "0"]),
      evaluator: new CheckEvaluator({ cwd: dir, shell: CHECK }),
      gates: commandGate("check", { cwd: dir, shell: CHECK }),
      config: { maxIterations: 2 },
    });

    const result = await loop.run();

    expect(result.records[0]?.accepted).toBe(true);
    expect(result.records[1]?.accepted).toBe(false);
    expect(result.records[1]?.gate?.passed).toBe(false);

    // rolled back to the accepted (value=1) commit
    const value = execFileSync("cat", ["value.txt"], { cwd: dir, encoding: "utf8" }).trim();
    expect(value).toBe("1");
  });
});
