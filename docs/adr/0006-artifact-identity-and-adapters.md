# ADR-0006: Artifact identity, adapters and content-addressed candidates

Status: accepted (2026-10-22).

## Context

`@mentat/core` already declared `IterableArtifact` (`kind`, `id`, `version`,
`form`, `apply`, `snapshot`, `evalSpec`). In practice it could not carry the
"everything is iterable" goal:

- only memory and the model catalog implemented it, and the model catalog has
  no production importer;
- `snapshot()` returned an untyped `JsonValue`, forcing `as unknown as` at three
  call sites and a `ArtifactRebuilder` callback in `JsonStoreWorkspace`;
- `apply(rt)` assumed every artifact installs into a service container, while
  code iterations run through `GitWorkspace` and never call it;
- `evalSpec()` had no consumer and let the iterated object declare its own
  scoring;
- `version` was a hand-built string (`memory:${ids}`), not a content address;
- `protected` was checked by object identity, which both rejects reloaded
  candidates and misses payload rewrites.

## Decision

Split the old interface into four contracts:

1. **`ArtifactRef`** — serializable identity: `kind`, `id`, `version`,
   `digest`, `form`, optional `trust` and `protected`.
2. **`Artifact`** — `{ ref, payload }`, where `payload` is the canonical JSON
   projection. No closures, so candidates and archives can be persisted and
   replayed.
3. **`ArtifactAdapter<P>`** — per-kind vocabulary: `parse`, `snapshot`,
   `restore`, `materialize`, optional `diff`. Evaluation is deliberately not
   part of it.
4. **`ArtifactRegistry`** — the dependency-inversion point. Domain packages
   register adapters; `core` does not import memory/models/skills.

Identity is content-addressed over canonical JSON (`sha256:<hex>`); code
artifacts use `git:<commit>`. Data candidates are persisted as references only,
with payloads in a content-addressed store (`<store>/artifacts/<sha256>.json`).

Protected artifacts are compared by `kind:id` + `digest`, and the replacement
must keep the `protected` marker. No object identity is involved.

## Alternatives considered

- Keep the fat `IterableArtifact` and add methods for code: rejected — one
  method cannot express both `provide(service, value)` and a git transaction.
- A class hierarchy per kind: rejected — it binds payload to materialization,
  which are orthogonal (the same skill can be persisted or executed).
- Git for every artifact, including data: rejected — data is a high-churn hot
  path and does not fit git's commit/locking model. Git stays for code; digests
  join both planes at the manifest.
- Keep `evalSpec` on the artifact: rejected — the evaluated object must not own
  the scoring rule. Evaluation belongs to an external, versioned protocol.

## Consequences

- `JsonStoreWorkspace.load(dir, registry)` no longer needs a rebuild callback.
- Candidates expose `kind:id/digest` lineage and can be archived verbatim.
- `FunctionEvaluator` materializes only `form: "data"`; code is materialized by
  the workspace transaction (a commit), which is now recorded as a code
  artifact on the child candidate.
- Adding a data artifact kind costs one adapter + one registration; the loop and
  workspaces do not change.
- The remaining planes from the design note (contrastive evaluation, protocol
  registry, persisted receipts, trust-tier enforcement) are staged; this ADR
  only fixes the identity/adapters boundary they depend on.
