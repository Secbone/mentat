import type { Policy } from "@mentat/domain";
import { Engine, InMemoryRepositories } from "@mentat/domain";

/**
 * The narrow DSH surface this plugin uses. Keeping it structural avoids
 * importing DSH packages into Mentat's typecheck while still matching the
 * Cordis plugin contract.
 */
export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: "text"; text: string }>;
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

export interface DshContext {
  provide(name: string, value: unknown): () => void;
  tools: { register(definition: DshToolDefinition): () => void };
}

export interface MentatService {
  engine: Engine;
  repos: InMemoryRepositories;
}

const POLICY: Policy = {
  version: 1,
  acceptMode: "off",
  rules: [],
  sources: {},
};

export const name = "mentat";
export const inject = ["tools"];

/** Mount the Mentat control plane and its first status tool into DSH. */
export function apply(ctx: DshContext): void {
  const repos = new InMemoryRepositories();
  const engine = new Engine({ repos, policy: () => POLICY });
  const service: MentatService = { engine, repos };
  ctx.provide("mentat", service);

  ctx.tools.register({
    name: "mentat_status",
    description: "Return Mentat's current ticket, thread and decision counts.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: {
          tickets: { type: "number" },
          threads: { type: "number" },
          decisions: { type: "number" },
        },
        required: ["tickets", "threads", "decisions"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute() {
      return {
        tickets: repos.tickets.list().length,
        threads: repos.threads.list().length,
        decisions: repos.decisions.list().length,
      };
    },
  });
}
