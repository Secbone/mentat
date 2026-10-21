import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "@mentat/evolution";
import { describe, expect, it } from "vitest";
import { CheckEvaluator, JsonCommandEvaluator } from "./evaluators";

const cwd = mkdtempSync(join(tmpdir(), "mentat-eval-"));
const candidate: Candidate = { id: "x", version: "x", artifacts: [] };

describe("CheckEvaluator", () => {
  it("emits 1 for a passing check and 0 for a failing one", async () => {
    const pass = new CheckEvaluator({ cwd, command: "node", args: ["-e", "process.exit(0)"] });
    const fail = new CheckEvaluator({ cwd, command: "node", args: ["-e", "process.exit(1)"] });
    expect((await pass.evaluate(candidate))[0]?.value).toBe(1);
    expect((await fail.evaluate(candidate))[0]?.value).toBe(0);
  });
});

describe("JsonCommandEvaluator", () => {
  it("parses Signal[] from stdout", async () => {
    const evaluator = new JsonCommandEvaluator({
      cwd,
      command: "node",
      args: [
        "-e",
        "console.log(JSON.stringify([{name:'tests',value:3,direction:'higher-better'}]))",
      ],
    });
    expect((await evaluator.evaluate(candidate))[0]).toEqual({
      name: "tests",
      value: 3,
      direction: "higher-better",
    });
  });

  it("fails the evaluation rather than replacing the metric contract", async () => {
    const evaluator = new JsonCommandEvaluator({
      cwd,
      command: "node",
      args: ["-e", "process.exit(1)"],
    });
    await expect(evaluator.evaluate(candidate)).rejects.toThrow("evaluation command failed");
  });
});
