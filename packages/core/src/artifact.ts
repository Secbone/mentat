import { type Digest, digestOf } from "./digest";
import type { Disposable, JsonValue, MaybePromise } from "./types";

/**
 * Everything the framework can iterate on. Memory, tools, skills, models,
 * prompts, policies, adapters and core code all share the same identity and
 * lifecycle contract; only their payloads and materialization differ.
 */
export type ArtifactKind =
  | "prompt"
  | "tool"
  | "skill"
  | "memory"
  | "model"
  | "policy"
  | "adapter"
  | "core"
  | "pipeline";

/** How the artifact is mutated: source code (workspace commit) or data (JSON). */
export type ArtifactForm = "code" | "data";

/**
 * How much evidence backs an artifact version. `constitution` is reserved for
 * the evaluation protocol, gates and the loop itself; it cannot be changed by
 * the inner loop. See docs/adr/0006.
 */
export type TrustTier = "constitution" | "trusted" | "reviewed" | "candidate";

/** Content-addressed identity of one artifact version. */
export interface ArtifactRef {
  readonly kind: ArtifactKind;
  readonly id: string;
  readonly version: string;
  readonly digest: Digest;
  readonly form: ArtifactForm;
  readonly trust?: TrustTier;
  /** Protected references may not be replaced by the inner loop. */
  readonly protected?: boolean;
}

/**
 * An immutable artifact value: identity plus its (already validated) JSON
 * payload. Payloads never contain closures, so candidates and archives are
 * serializable and can be replayed in another process.
 */
export interface Artifact {
  readonly ref: ArtifactRef;
  readonly payload: JsonValue;
}

/** A single measured dimension of an evaluation. */
export interface Signal {
  name: string;
  value: number;
  direction: "higher-better" | "lower-better";
}

/**
 * Minimal surface an artifact can install itself into. This is the *data*
 * host; code artifacts are materialized by a workspace transaction instead
 * (see `ArtifactForm`).
 */
export interface ArtifactHost {
  get<T>(key: string): T;
  provide<T>(key: string, value: T): Disposable;
}

/** @deprecated use {@link ArtifactHost}. Kept as an alias for the kernel. */
export type Runtime = ArtifactHost;

/** Structured change summary used for audit and candidate diffs. */
export interface ArtifactDiff {
  changed: boolean;
  summary?: string;
  details?: JsonValue;
}

/**
 * Kind-specific vocabulary. An adapter validates, serializes and materializes
 * one payload type. It deliberately says nothing about evaluation or safety:
 * those are external, cross-cutting concerns.
 */
export interface ArtifactAdapter<P = JsonValue> {
  readonly kind: ArtifactKind;
  readonly form: ArtifactForm;
  /** Validate untrusted input (model output, disk) and return the payload. */
  parse(raw: unknown): P;
  /** Canonical JSON form used for hashing and persistence. */
  snapshot(payload: P): JsonValue;
  /** Inverse of {@link snapshot}; validates while reading. */
  restore(snapshot: JsonValue): P;
  /** Install the payload into a data host. */
  materialize(payload: P, host: ArtifactHost): MaybePromise<Disposable>;
  diff?(before: P, after: P): ArtifactDiff;
}

/**
 * Existential form stored in the registry. The generic parameter is erased at
 * this one boundary; every adapter still has a typed payload internally.
 */
export interface ErasedArtifactAdapter {
  readonly kind: ArtifactKind;
  readonly form: ArtifactForm;
  parse(raw: unknown): unknown;
  snapshot(payload: unknown): JsonValue;
  restore(snapshot: JsonValue): unknown;
  materialize(payload: unknown, host: ArtifactHost): MaybePromise<Disposable>;
  diff?(before: unknown, after: unknown): ArtifactDiff;
}

/** Register a typed adapter by erasing its payload type in one place. */
export function defineArtifactAdapter<P>(adapter: ArtifactAdapter<P>): ErasedArtifactAdapter {
  return {
    kind: adapter.kind,
    form: adapter.form,
    parse: (raw) => adapter.parse(raw),
    snapshot: (payload) => adapter.snapshot(payload as P),
    restore: (snapshot) => adapter.restore(snapshot),
    materialize: (payload, host) => adapter.materialize(payload as P, host),
    ...(adapter.diff
      ? { diff: (before, after) => adapter.diff?.(before as P, after as P) ?? { changed: false } }
      : {}),
  };
}

export interface CreateArtifactOptions {
  version?: string;
  protected?: boolean;
  trust?: TrustTier;
  /** Override the computed digest (code artifacts use `git:<commit>`). */
  digest?: Digest;
}

/**
 * Build an immutable artifact from a typed payload.
 *
 * The payload is validated, snapshotted and content-addressed immediately, so
 * an artifact can never exist in an unserializable or stale form.
 */
export function createArtifact<P>(
  adapter: ArtifactAdapter<P>,
  id: string,
  payload: P,
  options: CreateArtifactOptions = {},
): Artifact {
  if (typeof id !== "string" || !id.trim()) throw new Error("artifact id is required");
  const parsed = adapter.parse(payload);
  const snapshot = adapter.snapshot(parsed);
  const digest = options.digest ?? digestOf(snapshot);
  return {
    ref: {
      kind: adapter.kind,
      id,
      version: options.version ?? digest,
      digest,
      form: adapter.form,
      ...(options.trust ? { trust: options.trust } : {}),
      ...(options.protected ? { protected: true } : {}),
    },
    payload: snapshot,
  };
}

/** Key under which a reference is unique inside a candidate manifest. */
export function refKey(ref: ArtifactRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** True when two references denote the same kind, id and content. */
export function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.kind === b.kind && a.id === b.id && a.digest === b.digest;
}

/**
 * Per-kind adapter registry. This is the dependency-inversion point: `core`
 * does not import memory/models/skills; domain packages register their
 * adapters, and the loop only sees this interface.
 */
export class ArtifactRegistry {
  private readonly adapters = new Map<ArtifactKind, ErasedArtifactAdapter>();

  register<P>(adapter: ArtifactAdapter<P>): this {
    const erased = defineArtifactAdapter(adapter);
    const existing = this.adapters.get(erased.kind);
    if (existing) throw new Error(`artifact adapter already registered: ${erased.kind}`);
    this.adapters.set(erased.kind, erased);
    return this;
  }

  has(kind: ArtifactKind): boolean {
    return this.adapters.has(kind);
  }

  kinds(): ArtifactKind[] {
    return [...this.adapters.keys()].sort();
  }

  adapter(kind: ArtifactKind): ErasedArtifactAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no artifact adapter registered for kind: ${kind}`);
    return adapter;
  }

  /** Validate an artifact's payload and re-check its content digest. */
  validate(artifact: Artifact): void {
    const adapter = this.adapter(artifact.ref.kind);
    if (adapter.form !== artifact.ref.form)
      throw new Error(`artifact form mismatch: ${artifact.ref.kind}`);
    const payload = adapter.parse(artifact.payload);
    const expected = digestOf(adapter.snapshot(payload));
    if (artifact.ref.digest.startsWith("sha256:") && artifact.ref.digest !== expected)
      throw new Error(`artifact digest mismatch: ${artifact.ref.kind}:${artifact.ref.id}`);
  }

  materialize(artifact: Artifact, host: ArtifactHost): MaybePromise<Disposable> {
    // Refuse to execute a payload that no longer matches its content address.
    this.validate(artifact);
    const adapter = this.adapter(artifact.ref.kind);
    const payload = adapter.parse(artifact.payload);
    return adapter.materialize(payload, host);
  }

  diff(before: Artifact, after: Artifact): ArtifactDiff {
    if (before.ref.kind !== after.ref.kind) return { changed: true };
    const adapter = this.adapter(before.ref.kind);
    if (!adapter.diff) return { changed: before.ref.digest !== after.ref.digest };
    return adapter.diff(adapter.parse(before.payload), adapter.parse(after.payload));
  }
}

/** A registry with no adapters; useful as an explicit, testable default. */
export function createArtifactRegistry(): ArtifactRegistry {
  return new ArtifactRegistry();
}
