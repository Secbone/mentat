import { type Artifact, refKey } from "@mentat/core";
import type { Candidate, Proposal } from "./types";

/**
 * Where candidates live. The loop applies a proposal to produce a child,
 * then either commits it (accepted) or rolls it back (rejected).
 * Code workspaces commit to git; data workspaces persist content-addressed
 * payloads. Both expose the same transaction surface.
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

/** Reject ambiguous manifests before they reach a workspace or archive. */
export function validateArtifacts(artifacts: readonly Artifact[]): void {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    const key = refKey(artifact.ref);
    if (seen.has(key)) throw new Error(`duplicate artifact reference: ${key}`);
    seen.add(key);
  }
}

let counter = 0;

/** In-memory workspace for deterministic tests. */
export class InMemoryWorkspace implements Workspace {
  private active: Candidate;
  private readonly parents = new Map<string, Candidate>();
  private readonly identities: Set<string>;

  constructor(root: Candidate) {
    validateArtifacts(root.artifacts);
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
    const artifacts = proposal.artifacts ?? parent.artifacts;
    validateArtifacts(artifacts);
    const child: Candidate = {
      id: proposal.id,
      version: `v${++counter}`,
      artifacts,
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
    if (!parent) return;
    this.active = parent;
    this.parents.delete(child.id);
  }

  async checkout(candidate: Candidate): Promise<void> {
    this.active = candidate;
  }
}
