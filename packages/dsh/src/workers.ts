import { createOpenCodeAdapter, createPiAdapter } from "@mentat/harnesses";
import { HarnessWorker, type WorkerAdapter } from "@mentat/worker";

/** Compose one named Worker adapter; an unknown name is a hard error. */
export function createWorker(name: string): WorkerAdapter {
  if (name === "opencode")
    return new HarnessWorker(createOpenCodeAdapter({ binary: "opencode" }), { timeoutMs: 120_000 });
  if (name === "pi")
    return new HarnessWorker(createPiAdapter({ permissionMode: "auto" }), { timeoutMs: 120_000 });
  throw new Error(`unknown worker: ${name} (expected opencode or pi)`);
}

export function workerFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerAdapter | undefined {
  return env.MENTAT_WORKER ? createWorker(env.MENTAT_WORKER) : undefined;
}
