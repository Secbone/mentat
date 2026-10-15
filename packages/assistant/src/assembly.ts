import type { HarnessAdapter } from "@mentat/core";
import type { MemoryAccess } from "@mentat/memory";
import { ASSISTANT_PROMPT_VERSION, assistantPromptOptions } from "./prompt";
export async function assemblePrompt(memory: MemoryAccess, adapter: HarnessAdapter, task: string) {
  const snapshot = await memory.context(task);
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
    contexts: [{ name: "memory", text: snapshot.text }],
    selection: snapshot,
  };
  return {
    assembly,
    input: { text: task, context: snapshot.text },
    blocked: snapshot.omittedRequiredIds.length > 0,
  };
}
