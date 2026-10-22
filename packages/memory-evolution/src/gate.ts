import type { Candidate, Gate, GateResult } from "@mentat/evolution";
import { parseMemoryEntries } from "./artifact";

const NAME = "memory-schema";

function reject(reason: string): GateResult {
  return { passed: false, gate: NAME, reason };
}

/**
 * Data gate for memory artifacts: rejects malformed entries before they are
 * evaluated (schema, types, duplicate ids). The adapter owns the same schema,
 * so disk loading and proposals cannot drift from this check.
 */
export function memoryGate(artifactId = "memory"): Gate {
  return {
    name: NAME,
    check: (candidate: Candidate): GateResult => {
      const artifact = candidate.artifacts.find(
        (entry) => entry.ref.kind === "memory" && entry.ref.id === artifactId,
      );
      if (!artifact) return reject("memory artifact is missing");
      try {
        parseMemoryEntries(artifact.payload);
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
      return { passed: true, gate: NAME };
    },
  };
}
