import type { HarnessAdapter } from "@mentat/core";
import type { MemoryAccess } from "@mentat/memory";
import { normalizeTaskInput, type TaskInput } from "@mentat/session";
import { ASSISTANT_PROMPT_VERSION, assistantPromptOptions } from "./prompt";
export async function assemblePrompt(
  memory: MemoryAccess,
  adapter: HarnessAdapter,
  task: string | TaskInput,
) {
  const input = normalizeTaskInput(task);
  const snapshot = await memory.context(input.text);
  const contexts = [
    ...(input.hostPolicy !== undefined ? [{ name: "host-policy", text: input.hostPolicy }] : []),
    ...(input.materials?.map((material, index) => ({
      name: `quoted-material-${index + 1}`,
      ...material,
    })) ?? []),
    { name: "memory", text: snapshot.text },
  ];
  const references = contexts.filter((part) => part.name !== "host-policy");
  const assembly = {
    version: ASSISTANT_PROMPT_VERSION,
    delivery: adapter.capabilities().systemPrompt ?? "undeclared",
    sections: [
      {
        name: "assistant-policy",
        version: ASSISTANT_PROMPT_VERSION,
        text: assistantPromptOptions(adapter).systemPrompt,
      },
    ],
    contexts,
    selection: snapshot,
  };
  return {
    assembly,
    input: {
      text: input.text,
      ...(input.hostPolicy !== undefined ? { hostPolicy: input.hostPolicy } : {}),
      context:
        references.length === 1
          ? snapshot.text
          : references.map((part) => JSON.stringify(part)).join("\n"),
    },
    blocked: snapshot.omittedRequiredIds.length > 0,
  };
}
