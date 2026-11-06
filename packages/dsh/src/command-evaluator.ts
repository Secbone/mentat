import type { Signal } from "@mentat/core";
import { runCommand } from "@mentat/evaluation";
import type { PackEvaluator } from "@mentat/evolve";
import type { CapabilityPack } from "@mentat/pack";

export interface CommandPackEvaluatorOptions {
  /** Shell command that prints a Signal[] JSON array on stdout. */
  shell: string;
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Operator-configured pack evaluation. The command receives the pack as
 * MENTAT_PACK (JSON), MENTAT_PACK_VERSION and MENTAT_PACK_DIGEST; it prints a
 * Signal[] array. The model never supplies the evaluator.
 */
export class CommandPackEvaluator implements PackEvaluator {
  constructor(private readonly options: CommandPackEvaluatorOptions) {}

  async evaluate(pack: CapabilityPack): Promise<Signal[]> {
    const result = await runCommand({
      shell: this.options.shell,
      cwd: this.options.cwd,
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      env: {
        ...this.options.env,
        MENTAT_PACK: JSON.stringify(pack),
        MENTAT_PACK_VERSION: String(pack.version),
        MENTAT_PACK_DIGEST: pack.digest,
      },
    });
    if (!result.ok)
      throw new Error(`pack evaluation failed (${result.code}): ${result.stderr.trim()}`);
    const signals = JSON.parse(result.stdout) as Signal[];
    if (!Array.isArray(signals) || signals.length === 0)
      throw new Error("pack evaluation returned no signals");
    for (const signal of signals) {
      if (
        !signal ||
        typeof signal.name !== "string" ||
        !Number.isFinite(signal.value) ||
        (signal.direction !== "higher-better" && signal.direction !== "lower-better")
      )
        throw new Error("pack evaluation returned an invalid signal");
    }
    return signals;
  }
}
