import { type ArtifactRegistry, createArtifactRegistry } from "@mentat/core";
import { memoryAdapter } from "@mentat/memory-evolution";

/**
 * Adapters available to the data evolution paths. Code workspaces attach their
 * own code artifacts; this registry is for payload validation and evaluation.
 */
export function evolutionArtifacts(): ArtifactRegistry {
  return createArtifactRegistry().register(memoryAdapter);
}
