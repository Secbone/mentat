import type { Signal } from "@mentat/core";
import type { Candidate, Evaluator } from "@mentat/evolution";
import { validateSignals } from "@mentat/evolution";
import { type CommandSpec, runCommand } from "./command-gate";

/** Runs a check command and reports pass(1)/fail(0) as one signal. */
export class CheckEvaluator implements Evaluator {
  constructor(
    private readonly spec: CommandSpec,
    private readonly name = "check",
  ) {}

  async evaluate(_candidate: Candidate): Promise<Signal[]> {
    const result = await runCommand(this.spec);
    return [{ name: this.name, value: result.ok ? 1 : 0, direction: "higher-better" }];
  }
}

export interface JsonCommandEvaluatorOptions extends CommandSpec {
  /** Override how stdout becomes signals (default: parse the whole stdout as JSON). */
  parse?: (stdout: string) => Signal[];
}

/**
 * Runs a command that prints a `Signal[]` JSON array on stdout. On failure it
 * reports a single `eval.failed` signal so the loop sees a regression.
 */
export class JsonCommandEvaluator implements Evaluator {
  constructor(private readonly options: JsonCommandEvaluatorOptions) {}

  async evaluate(_candidate: Candidate): Promise<Signal[]> {
    const result = await runCommand(this.options);
    if (!result.ok) throw new Error(`evaluation command failed (${result.code}): ${result.stderr}`);
    const text = result.stdout.trim();
    const signals: Signal[] = this.options.parse
      ? this.options.parse(text)
      : (JSON.parse(text) as Signal[]);
    validateSignals(signals);
    return signals;
  }
}
