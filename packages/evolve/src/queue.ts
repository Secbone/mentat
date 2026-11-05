import type { JsonValue } from "@mentat/core";
import type { EffectQueue, EffectRecord } from "@mentat/effects";
import type { CapabilityPack } from "@mentat/pack";
import type { DreamService, EvolutionResult } from "./loop";
import type { Observation } from "./types";

export interface DreamJob {
  base: CapabilityPack;
  observations: Observation[];
}

/** Enqueue one offline Dream pass as a durable effect. */
export function enqueueDream(
  queue: EffectQueue,
  job: DreamJob,
  key = `dream:${job.base.id}`,
): EffectRecord {
  return queue.enqueue("dream", key, job as unknown as JsonValue);
}

/** Register the Dream handler; the runtime owns the queue loop. */
export function registerDream(
  queue: EffectQueue,
  dream: DreamService,
  onResult?: (result: EvolutionResult) => void,
): () => void {
  return queue.handle("dream", async (payload) => {
    const job = payload as unknown as DreamJob;
    const result = await dream.dream(job.base, job.observations);
    onResult?.(result);
  });
}
