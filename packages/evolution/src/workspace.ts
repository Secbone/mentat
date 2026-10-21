import type { Candidate, Proposal } from "./types";

/**
 * Where candidates live. The loop applies a proposal to produce a child,
 * then either commits it (accepted) or rolls it back (rejected).
 * The real implementation is git-backed; this interface is all the loop needs.
 */
export interface Workspace {
  current(): Candidate;
  /** Establish a clean transaction boundary before a proposer can mutate state. */
  begin?(): Promise<void>;
  /** Undo a failed proposal or partially failed materialization. */
  abort?(): Promise<void>;
  /** Observable change evidence, captured before evaluation or rollback. */
  inspect?(candidate: Candidate): Promise<import("@mentat/core").JsonValue>;
  apply(proposal: Proposal): Promise<Candidate>;
  commit(child: Candidate): Promise<void>;
  rollback(child: Candidate): Promise<void>;
  /** Make a candidate the active base (used for open-ended branching). */
  checkout?(candidate: Candidate): Promise<void>;
  /** Finalize the selected accepted candidate after exploratory branches finish. */
  settle?(candidate: Candidate): Promise<void>;
}

let counter = 0;

/** In-memory workspace for deterministic tests. */
export class InMemoryWorkspace implements Workspace {
  private active: Candidate;
  private readonly parents = new Map<string, Candidate>();
  private readonly identities: Set<string>;

  constructor(root: Candidate) {
    this.active = root;
    this.identities = new Set([root.id]);
  }

  current(): Candidate {
    return this.active;
  }

  async apply(proposal: Proposal): Promise<Candidate> {
    if (this.identities.has(proposal.id)) throw new Error("candidate identity already exists");
    this.identities.add(proposal.id);
    const parent = this.active;
    const child: Candidate = {
      id: proposal.id,
      version: `v${++counter}`,
      artifacts: proposal.artifacts ?? [],
      parentId: parent.id,
    };
    this.parents.set(child.id, parent);
    this.active = child;
    return child;
  }

  async commit(child: Candidate): Promise<void> {
    if (this.active.id === child.id) this.parents.delete(child.id);
  }

  async checkout(candidate: Candidate): Promise<void> {
    this.active = candidate;
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
