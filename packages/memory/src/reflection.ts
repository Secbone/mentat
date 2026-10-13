import { extractJson } from "@mentat/core";

export interface ReflectionInput {
  task: string;
  outcome: string;
  tools: string[];
}

/** Prompt that asks an agent to distill durable memories from a finished task. */
export function reflectionPrompt(input: ReflectionInput): string {
  return [
    "You just completed a task. Extract durable memory entries worth remembering",
    "for future tasks in this project: stable facts about the repository, user",
    "preferences, or key findings. Ignore transient details and anything task-specific.",
    "",
    `Task: ${input.task}`,
    `Outcome: ${input.outcome}`,
    `Tools used: ${input.tools.join(", ") || "(none)"}`,
    "",
    'Return ONLY a JSON array of {"id":string,"text":string,"createdAt":number}.',
    "Return [] if nothing is worth remembering.",
  ].join("\n");
}

/** Parse the agent's reflection output into a list of memory texts. */
export function parseReflectedMemories(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const facts: string[] = [];
  for (const raw of parsed) {
    if (raw && typeof raw === "object") {
      const value = (raw as { text?: unknown }).text;
      if (typeof value === "string" && value.trim().length > 0) facts.push(value.trim());
    }
  }
  return facts;
}
