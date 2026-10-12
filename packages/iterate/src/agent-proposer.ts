import type { Candidate, Proposal, Proposer, Signal } from "@mentat/core";

export interface ProposeContext {
  parent: Candidate;
  signals: Signal[];
  task: string;
  logDir?: string;
}

/** Runs an agent session that edits the workspace in place. */
export type SessionRunner = (prompt: string, context: { cwd: string }) => Promise<void>;

export interface AgentProposerOptions {
  id?: string;
  task: string;
  cwd: string;
  runner: SessionRunner;
  /** Previous run logs the agent may read to decide what to improve. */
  logDir?: string;
  buildPrompt?: (context: ProposeContext) => string;
}

export function defaultPrompt(context: ProposeContext): string {
  const signals = context.signals
    .map((signal) => `  ${signal.name}=${signal.value} (${signal.direction})`)
    .join("\n");
  const lines = [
    "You are improving a code repository.",
    `Task: ${context.task}`,
    "",
    "Current evaluation signals:",
    signals || "  (none)",
    "",
    "Make the smallest change that improves the signals while keeping everything else working.",
    "Do not modify safety gates, the self-iteration loop, or the test infrastructure.",
  ];
  if (context.logDir) {
    lines.push("", `Execution logs from previous runs: ${context.logDir}`);
  }
  return lines.join("\n");
}

/** Turns any {@link SessionRunner} (Pi, opencode, a fake) into a {@link Proposer}. */
export class AgentProposer implements Proposer {
  private readonly id: string;
  private counter = 0;

  constructor(private readonly options: AgentProposerOptions) {
    this.id = options.id ?? "agent";
  }

  async propose(parent: Candidate, signals: Signal[]): Promise<Proposal> {
    const build = this.options.buildPrompt ?? defaultPrompt;
    const prompt = build({
      parent,
      signals,
      task: this.options.task,
      ...(this.options.logDir ? { logDir: this.options.logDir } : {}),
    });
    await this.options.runner(prompt, { cwd: this.options.cwd });
    this.counter += 1;
    return { id: `${this.id}-${this.counter}`, description: this.options.task };
  }
}
