import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, IterableArtifact, JsonValue, Proposal, Workspace } from "@mentat/core";

export interface ArtifactSnapshot {
  kind: string;
  id: string;
  version: string;
  snapshot: JsonValue;
}

export type ArtifactRebuilder = (snapshot: ArtifactSnapshot) => IterableArtifact;

interface StoredCandidate {
  id: string;
  version: string;
  parentId?: string;
  artifacts: ArtifactSnapshot[];
}

function snapshotArtifact(artifact: IterableArtifact): ArtifactSnapshot {
  return {
    kind: artifact.kind,
    id: artifact.id,
    version: artifact.version,
    snapshot: artifact.snapshot(),
  };
}

/**
 * A {@link Workspace} for *data* artifacts (memory, prompts, model config).
 * Each candidate is persisted as JSON under `dir`, and `current.json` points at
 * the active one, so a later run can resume the evolved state via {@link load}.
 */
export class JsonStoreWorkspace implements Workspace {
  private active: Candidate;
  private readonly parents = new Map<string, Candidate>();
  private readonly dir: string;

  constructor(dir: string, root: Candidate) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.active = root;
    this.persist(root);
    this.writeCurrent();
  }

  current(): Candidate {
    return this.active;
  }

  async apply(proposal: Proposal): Promise<Candidate> {
    const parent = this.active;
    const child: Candidate = {
      id: proposal.id,
      version: `v${Date.now().toString(36)}`,
      artifacts: proposal.artifacts ?? [],
      parentId: parent.id,
    };
    this.parents.set(child.id, parent);
    this.active = child;
    this.persist(child);
    this.writeCurrent();
    return child;
  }

  async commit(child: Candidate): Promise<void> {
    this.parents.delete(child.id);
  }

  async rollback(child: Candidate): Promise<void> {
    if (this.active.id !== child.id) return;
    const parent = this.parents.get(child.id);
    if (!parent) return;
    this.active = parent;
    this.parents.delete(child.id);
    this.writeCurrent();
  }

  async checkout(candidate: Candidate): Promise<void> {
    this.active = candidate;
    this.writeCurrent();
  }

  private persist(candidate: Candidate): void {
    const stored: StoredCandidate = {
      id: candidate.id,
      version: candidate.version,
      ...(candidate.parentId ? { parentId: candidate.parentId } : {}),
      artifacts: candidate.artifacts.map(snapshotArtifact),
    };
    writeFileSync(join(this.dir, `${candidate.id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
  }

  private writeCurrent(): void {
    writeFileSync(
      join(this.dir, "current.json"),
      `${JSON.stringify({ active: this.active.id })}\n`,
    );
  }

  /** Rebuild the active candidate of a previous run, or undefined if none. */
  static load(dir: string, rebuild: ArtifactRebuilder): Candidate | undefined {
    const currentPath = join(dir, "current.json");
    if (!existsSync(currentPath)) return undefined;
    const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { active?: unknown };
    if (typeof pointer.active !== "string") return undefined;
    const file = join(dir, `${pointer.active}.json`);
    if (!existsSync(file)) return undefined;
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredCandidate;
    return {
      id: stored.id,
      version: stored.version,
      artifacts: stored.artifacts.map(rebuild),
      ...(stored.parentId ? { parentId: stored.parentId } : {}),
    };
  }
}
