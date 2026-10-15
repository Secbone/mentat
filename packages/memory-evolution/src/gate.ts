import type { Candidate, Gate, GateResult } from "@mentat/evolution";

const NAME = "memory-schema";

function reject(reason: string): GateResult {
  return { passed: false, gate: NAME, reason };
}

/**
 * Data gate for memory artifacts: rejects malformed entries before they are
 * evaluated (schema, types, duplicate ids). Cheap and deterministic.
 */
export function memoryGate(artifactId = "memory"): Gate {
  return {
    name: NAME,
    check: (candidate: Candidate): GateResult => {
      const artifact = candidate.artifacts.find((entry) => entry.id === artifactId);
      const snapshot = artifact?.snapshot();
      if (!Array.isArray(snapshot)) return reject("memory snapshot is not an array");
      const seen = new Set<string>();
      for (const raw of snapshot) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          return reject("entry is not an object");
        const entry = raw as Record<string, unknown>;
        if (typeof entry.id !== "string" || entry.id.length === 0) {
          return reject("entry.id must be a non-empty string");
        }
        if (typeof entry.text !== "string") return reject("entry.text must be a string");
        if (typeof entry.createdAt !== "number") return reject("entry.createdAt must be a number");
        if (seen.has(entry.id)) return reject(`duplicate entry id: ${entry.id}`);
        seen.add(entry.id);
      }
      return { passed: true, gate: NAME };
    },
  };
}
