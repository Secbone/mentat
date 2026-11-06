import { defineCapabilityPack } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import { CommandPackEvaluator } from "./command-evaluator";

const pack = defineCapabilityPack({
  id: "worker",
  version: 3,
  prompt: { system: "x", role: "worker" },
});

describe("CommandPackEvaluator", () => {
  it("passes the pack to the operator command and parses signals", async () => {
    const evaluator = new CommandPackEvaluator({
      shell:
        "node -e \"console.log(JSON.stringify([{name:'quality',value:Number(process.env.MENTAT_PACK_VERSION),direction:'higher-better'}]))\"",
      cwd: "/tmp",
      timeoutMs: 10_000,
    });
    await expect(evaluator.evaluate(pack)).resolves.toEqual([
      { name: "quality", value: 3, direction: "higher-better" },
    ]);
  });

  it("rejects an invalid signal payload", async () => {
    const evaluator = new CommandPackEvaluator({
      shell: "node -e \"console.log('{}')\"",
      cwd: "/tmp",
      timeoutMs: 10_000,
    });
    await expect(evaluator.evaluate(pack)).rejects.toThrow("no signals");
  });
});
