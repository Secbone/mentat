import type { Signal } from "@mentat/core";
import type { Candidate, Proposal, Proposer } from "@mentat/evolution";
import type { MemoryEntry } from "@mentat/memory";
import { memoryArtifact } from "./artifact";

function entriesOf(parent: Candidate): MemoryEntry[] {
  const snapshot = parent.artifacts[0]?.snapshot();
  return Array.isArray(snapshot) ? (snapshot as unknown as MemoryEntry[]) : [];
}

/**
 * Rule-based mutation for memory: propose adding the next candidate entry the
 * parent does not already have (id-level dedup). Deterministic, no model.
 */
export class RuleMemoryProposer implements Proposer {
  private index = 0;

  constructor(
    private readonly candidates: MemoryEntry[],
    private readonly artifactId = "memory",
  ) {}

  async propose(parent: Candidate, _signals: Signal[]): Promise<Proposal> {
    const current = entriesOf(parent);
    const existing = new Set(current.map((entry) => entry.id));

    while (this.index < this.candidates.length) {
      const draft = this.candidates[this.index];
      this.index += 1;
      if (!draft || existing.has(draft.id)) continue;
      return {
        id: `add-${draft.id}`,
        description: `add memory ${draft.id}`,
        artifacts: [memoryArtifact(this.artifactId, [...current, draft])],
      };
    }

    // nothing new to add: re-propose the parent (will be rejected as no change)
    return {
      id: "noop",
      description: "no new memory to add",
      artifacts: [memoryArtifact(this.artifactId, current)],
    };
  }
}
