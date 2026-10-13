import type { AgentEvent, HarnessAdapter } from "@mentat/core";
import { parseReflectedMemories, reflectionPrompt } from "@mentat/memory";
import { createPermissionHandler } from "./permission";

/**
 * Ask the harness to distill durable memories from a finished task and return
 * the surviving fact texts (parsing is tolerant — bad output yields `[]`).
 */
export async function reflectMemories(
  adapter: HarnessAdapter,
  options: { cwd: string; model?: string; task: string; outcome: string; tools: string[] },
): Promise<string[]> {
  const session = await adapter.createSession(
    { cwd: options.cwd, ...(options.model ? { model: options.model } : {}) },
    { onPermission: createPermissionHandler("full") },
  );
  let text = "";
  try {
    const settled = new Promise<void>((resolve) => {
      session.subscribe((event: AgentEvent) => {
        if (event.type === "message.completed") text = event.message.text;
        else if (event.type === "run.settled") resolve();
      });
    });
    await session.send({ text: reflectionPrompt(options) });
    await settled;
  } finally {
    await session.dispose();
  }
  return parseReflectedMemories(text);
}
