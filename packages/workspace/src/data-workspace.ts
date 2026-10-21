import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IterableArtifact, JsonValue } from "@mentat/core";
import type { Candidate, Proposal, Workspace } from "@mentat/evolution";
import { atomicJson, withFileLock } from "@mentat/storage-file";

export interface ArtifactSnapshot {
  kind: string;
  id: string;
  version: string;
  snapshot: JsonValue;
  protected?: boolean;
}

export type ArtifactRebuilder = (snapshot: ArtifactSnapshot) => IterableArtifact;

function candidateFile(dir: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(id) || id === "current")
    throw new Error("invalid candidate identity");
  return join(dir, `${id}.json`);
}

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
    ...(artifact.protected ? { protected: true } : {}),
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
  private committedId: string;

  constructor(dir: string, root: Candidate) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.active = root;
    this.committedId = root.id;
    withFileLock(join(dir, "workspace.lock"), () => {
      const current = join(dir, "current.json");
      if (existsSync(current) && JSON.parse(readFileSync(current, "utf8")).active !== root.id)
        throw new Error("active candidate changed; reload before opening the workspace");
      this.persist(root);
      if (!existsSync(current)) this.writeCurrent();
    });
  }

  current(): Candidate {
    return this.active;
  }

  async apply(proposal: Proposal): Promise<Candidate> {
    const parent = this.active;
    const child: Candidate = {
      id: proposal.id,
      version: `v-${crypto.randomUUID()}`,
      artifacts: proposal.artifacts ?? [],
      parentId: parent.id,
    };
    this.persist(child, true);
    this.parents.set(child.id, parent);
    this.active = child;
    // current.json denotes committed state; a crash during evaluation resumes its parent.
    return child;
  }

  async commit(child: Candidate): Promise<void> {
    if (this.active !== child) throw new Error("candidate is not active");
    this.publishCurrent();
    this.parents.delete(child.id);
  }

  async rollback(child: Candidate): Promise<void> {
    if (this.active.id !== child.id) return;
    const parent = this.parents.get(child.id);
    if (!parent) return;
    this.active = parent;
    this.parents.delete(child.id);
  }

  async checkout(candidate: Candidate): Promise<void> {
    this.persist(candidate);
    this.active = candidate;
    // Exploration may inspect rejected stepping stones; never publish them on checkout.
  }

  async settle(candidate: Candidate): Promise<void> {
    if (candidate.id !== this.active.id) throw new Error("selected candidate is not active");
    this.publishCurrent();
  }

  private persist(candidate: Candidate, exclusive = false): void {
    const stored: StoredCandidate = {
      id: candidate.id,
      version: candidate.version,
      ...(candidate.parentId ? { parentId: candidate.parentId } : {}),
      artifacts: candidate.artifacts.map(snapshotArtifact),
    };
    const path = candidateFile(this.dir, candidate.id);
    if (existsSync(path)) {
      if (
        exclusive ||
        JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !== JSON.stringify(stored)
      )
        throw new Error("candidate identity already exists; snapshots are immutable");
      return;
    }
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  }

  private writeCurrent(): void {
    atomicJson(join(this.dir, "current.json"), { active: this.active.id });
  }

  private publishCurrent(): void {
    withFileLock(join(this.dir, "workspace.lock"), () => {
      if (
        JSON.parse(readFileSync(join(this.dir, "current.json"), "utf8")).active !== this.committedId
      )
        throw new Error("active candidate changed; publication conflict");
      this.writeCurrent();
      this.committedId = this.active.id;
    });
  }

  /** Rebuild the active candidate of a previous run, or undefined if none. */
  static load(dir: string, rebuild: ArtifactRebuilder): Candidate | undefined {
    const currentPath = join(dir, "current.json");
    if (!existsSync(currentPath)) return undefined;
    const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { active?: unknown };
    if (typeof pointer.active !== "string") throw new Error("invalid active candidate pointer");
    const file = candidateFile(dir, pointer.active);
    if (!existsSync(file)) throw new Error("active candidate snapshot is missing");
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredCandidate;
    if (stored.id !== pointer.active || !Array.isArray(stored.artifacts))
      throw new Error("invalid candidate snapshot");
    return {
      id: stored.id,
      version: stored.version,
      artifacts: stored.artifacts.map((snapshot) => ({
        ...rebuild(snapshot),
        ...(snapshot.protected ? { protected: true } : {}),
      })),
      ...(stored.parentId ? { parentId: stored.parentId } : {}),
    };
  }
}
