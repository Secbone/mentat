import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, ArtifactRef, ArtifactRegistry } from "@mentat/core";
import type { Candidate, Proposal, Workspace } from "@mentat/evolution";
import { validateArtifacts } from "@mentat/evolution";
import { atomicJson, withFileLock } from "@mentat/storage-file";
import { ArtifactStore } from "./cas";

function candidateFile(dir: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(id) || id === "current")
    throw new Error("invalid candidate identity");
  return join(dir, `${id}.json`);
}

interface StoredCandidate {
  id: string;
  version: string;
  parentId?: string;
  artifacts: ArtifactRef[];
}

/**
 * A {@link Workspace} for *data* artifacts (memory, prompts, model config).
 *
 * Candidate files contain only content-addressed references; payloads live in
 * `<dir>/artifacts/<sha256>.json`. This keeps candidates small, makes archive
 * payloads deduplicated, and lets a later run resume without rebuilding
 * artifacts from closure factories.
 */
export class JsonStoreWorkspace implements Workspace {
  private active: Candidate;
  private readonly parents = new Map<string, Candidate>();
  private readonly dir: string;
  private readonly registry: ArtifactRegistry;
  private readonly store: ArtifactStore;
  private committedId: string;

  constructor(dir: string, root: Candidate, registry: ArtifactRegistry) {
    this.dir = dir;
    this.registry = registry;
    this.store = new ArtifactStore(join(dir, "artifacts"));
    mkdirSync(dir, { recursive: true });
    this.assertDataArtifacts(root.artifacts);
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
    const artifacts = proposal.artifacts ?? parent.artifacts;
    validateArtifacts(artifacts);
    this.assertDataArtifacts(artifacts);
    const child: Candidate = {
      id: proposal.id,
      version: `v-${crypto.randomUUID()}`,
      artifacts,
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
    this.assertDataArtifacts(candidate.artifacts);
    this.persist(candidate);
    this.active = candidate;
    // Exploration may inspect rejected stepping stones; never publish them on checkout.
  }

  async settle(candidate: Candidate): Promise<void> {
    if (candidate.id !== this.active.id) throw new Error("selected candidate is not active");
    this.publishCurrent();
  }

  private assertDataArtifacts(artifacts: readonly Artifact[]): void {
    for (const artifact of artifacts) {
      if (artifact.ref.form !== "data")
        throw new Error(`JsonStoreWorkspace only stores data artifacts: ${artifact.ref.kind}`);
      this.registry.validate(artifact);
      const stored = this.store.put(artifact.payload);
      if (stored !== artifact.ref.digest)
        throw new Error(`artifact digest mismatch: ${artifact.ref.kind}:${artifact.ref.id}`);
    }
  }

  private persist(candidate: Candidate, exclusive = false): void {
    const stored: StoredCandidate = {
      id: candidate.id,
      version: candidate.version,
      ...(candidate.parentId ? { parentId: candidate.parentId } : {}),
      artifacts: candidate.artifacts.map((artifact) => artifact.ref),
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

  /** Rehydrate the active candidate of a previous run, or undefined if none. */
  static load(dir: string, registry: ArtifactRegistry): Candidate | undefined {
    const currentPath = join(dir, "current.json");
    if (!existsSync(currentPath)) return undefined;
    const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { active?: unknown };
    if (typeof pointer.active !== "string") throw new Error("invalid active candidate pointer");
    const file = candidateFile(dir, pointer.active);
    if (!existsSync(file)) throw new Error("active candidate snapshot is missing");
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredCandidate;
    if (stored.id !== pointer.active || !Array.isArray(stored.artifacts))
      throw new Error("invalid candidate snapshot");
    if (stored.artifacts.some((ref) => typeof ref?.digest !== "string"))
      throw new Error(
        "legacy candidate format without content digests; start a new --store or migrate it explicitly",
      );
    const store = new ArtifactStore(join(dir, "artifacts"));
    const artifacts: Artifact[] = stored.artifacts.map((ref) => {
      const artifact = { ref, payload: store.get(ref.digest) };
      registry.validate(artifact);
      return artifact;
    });
    validateArtifacts(artifacts);
    return {
      id: stored.id,
      version: stored.version,
      artifacts,
      ...(stored.parentId ? { parentId: stored.parentId } : {}),
    };
  }
}
