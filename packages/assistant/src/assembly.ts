import type { HarnessAdapter } from "@mentat/core";
import type { MemoryAccess } from "@mentat/memory";
import { normalizeTaskInput, type TaskInput } from "@mentat/session";
import { ASSISTANT_PROMPT_VERSION, type AssistantTools, assistantPromptOptions } from "./prompt";
export async function assemblePrompt(
  memory: MemoryAccess,
  adapter: HarnessAdapter,
  task: string | TaskInput,
  tools?: AssistantTools,
  budget: { maxInputChars?: number; memoryChars?: number } = {},
) {
  const input = normalizeTaskInput(task);
  const maxInputChars = budget.maxInputChars ?? 100_000;
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars <= 0)
    throw new Error("invalid input context budget");
  const snapshot = await memory.context(input.text, budget.memoryChars);
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
        text: assistantPromptOptions(adapter, tools).systemPrompt,
      },
    ],
    contexts,
    selection: snapshot,
  };
  const assembledInput = {
    text: input.text,
    ...(input.hostPolicy !== undefined ? { hostPolicy: input.hostPolicy } : {}),
    context:
      references.length === 1
        ? snapshot.text
        : references.map((part) => JSON.stringify(part)).join("\n"),
  };
  const usedChars =
    JSON.stringify(assembledInput).length + (assembly.sections[0]?.text?.length ?? 0);
  return {
    assembly: { ...assembly, budget: { maxInputChars, usedChars } },
    input: assembledInput,
    blocked: snapshot.omittedRequiredIds.length > 0 || usedChars > maxInputChars,
    blockedReason: snapshot.omittedRequiredIds.length
      ? "required constraints exceed context budget"
      : usedChars > maxInputChars
        ? "assembled input exceeds context budget"
        : undefined,
  };
}
