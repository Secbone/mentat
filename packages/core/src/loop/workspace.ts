import type { Candidate, Proposal } from "./types";

/**
 * Where candidates live. The loop applies a proposal to produce a child,
 * then either commits it (accepted) or rolls it back (rejected).
 * The real implementation is git-backed; this interface is all the loop needs.
 */
export interface Workspace {
  current(): Candidate;
  apply(proposal: Proposal): Promise<Candidate>;
  commit(child: Candidate): Promise<void>;
  rollback(child: Candidate): Promise<void>;
}

let counter = 0;

/** In-memory workspace for deterministic tests. */
export class InMemoryWorkspace implements Workspace {
  private active: Candidate;
  private readonly parents = new Map<string, Candidate>();

  constructor(root: Candidate) {
    this.active = root;
  }

  current(): Candidate {
    return this.active;
  }

  async apply(proposal: Proposal): Promise<Candidate> {
    const parent = this.active;
    const child: Candidate = {
      id: proposal.id,
      version: `v${++counter}`,
      artifacts: proposal.artifacts,
      parentId: parent.id,
    };
    this.parents.set(child.id, parent);
    this.active = child;
    return child;
  }

  async commit(child: Candidate): Promise<void> {
    if (this.active.id === child.id) this.parents.delete(child.id);
  }

  async rollback(child: Candidate): Promise<void> {
    if (this.active.id !== child.id) return;
    const parent = this.parents.get(child.id);
    if (parent) {
      this.active = parent;
      this.parents.delete(child.id);
    }
  }
}
