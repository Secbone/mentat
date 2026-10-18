import type { ExperienceRecord } from "@mentat/session";

export interface ReflectionTriggerInput {
  /** Explicit caller request (e.g. `--reflect`); always reflects. */
  explicit?: boolean;
  /** Count of user corrections attached to the interactions under review. */
  corrections?: number;
  interactions?: ExperienceRecord[];
}

export type ReflectionTriggerReason =
  | "explicit"
  | "user-correction"
  | "tool-failures"
  | "no-interactions"
  | "no-new-evidence";

export interface ReflectionTriggerDecision {
  reflect: boolean;
  reason: ReflectionTriggerReason;
  signals: string[];
}

/**
 * Evidence-gated reflection policy. A normally-finished task is not a
 * correctness signal, so completion alone does not justify a reflection call;
 * reflection is warranted by evidence worth learning from (a user correction or
 * reusable tool failures) or by an explicit request. Keeps reflection cost tied
 * to learnable signal rather than to every task.
 */
export function reflectionTrigger(input: ReflectionTriggerInput): ReflectionTriggerDecision {
  if (input.explicit) return { reflect: true, reason: "explicit", signals: ["explicit"] };
  const interactions = input.interactions ?? [];
  if (interactions.length === 0) return { reflect: false, reason: "no-interactions", signals: [] };

  const corrections = input.corrections ?? 0;
  const toolErrors = interactions.reduce((sum, record) => sum + (record.toolErrors ?? 0), 0);
  const signals: string[] = [];
  if (corrections > 0) signals.push("user-corrections");
  if (toolErrors > 0) signals.push("tool-failures");
  if (corrections > 0) return { reflect: true, reason: "user-correction", signals };
  if (toolErrors > 0) return { reflect: true, reason: "tool-failures", signals };
  return { reflect: false, reason: "no-new-evidence", signals: [] };
}
