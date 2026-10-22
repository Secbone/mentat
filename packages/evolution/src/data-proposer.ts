import type { Artifact, Signal } from "@mentat/core";
import type { Candidate, Proposal, Proposer } from "@mentat/evolution";

export interface DataPromptContext {
  parent: Candidate;
  signals: Signal[];
  task: string;
}

/** Runs an agent session that returns text (e.g. a revised JSON artifact set). */
export type DataRunner = (prompt: string, context: { cwd: string }) => Promise<string>;

export interface AgentDataProposerOptions {
  id?: string;
  task: string;
  cwd: string;
  runner: DataRunner;
  buildPrompt: (context: DataPromptContext) => string;
  /** Turn the agent's text into the new artifact set. */
  parse: (output: string, parent: Candidate) => Artifact[];
}

/**
 * Agent-driven mutation for *data* artifacts: the agent reads the current
 * artifact state + evaluation signals and returns the revised artifact set.
 */
export class AgentDataProposer implements Proposer {
  private readonly id: string;
  private counter = 0;

  constructor(private readonly options: AgentDataProposerOptions) {
    this.id = options.id ?? "agent-data";
  }

  async propose(parent: Candidate, signals: Signal[]): Promise<Proposal> {
    const prompt = this.options.buildPrompt({ parent, signals, task: this.options.task });
    const output = await this.options.runner(prompt, { cwd: this.options.cwd });
    const artifacts = this.options.parse(output, parent);
    this.counter += 1;
    return {
      id: `${this.id}-${crypto.randomUUID()}-${this.counter}`,
      description: this.options.task,
      artifacts,
    };
  }
}
