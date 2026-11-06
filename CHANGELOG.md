# Changelog

Notable changes. Loosely follows [Keep a Changelog](https://keepachangelog.com/).
Authoritative architecture decisions live in [`docs/adr/`](docs/adr/); the
milestone list in [`docs/plan.md`](docs/plan.md) is historical background.

## Unreleased

### Docs
- Add ADR-0007 and `docs/research/mentat-on-dsh-2026-11-05.md`: Mentat as a
  DSH-hosted product with a Router/Worker control plane, heterogeneous workers
  and a versioned Capability Pack for self-evolution.

### Added
- `PackChannel`: deterministic stable/canary selection, promotion and rollback
  with durable `pack-channel.json` state. Assignments and receipts record the
  selected channel; `mentat_channel` exposes status/canary/promote/rollback,
  and the panel overview shows the active versions.
- `MentatEvolver` + `EvolutionScheduler`: read failed Assignment receipts,
  deduplicate and skip already-learned observations, then run Dream through the
  configured pack evaluator. Exposed as `mentat_evolve` and an optional
  `MENTAT_EVOLVE_INTERVAL_MS` periodic pass.
- `BenchmarkPackEvaluator`: run a `@mentat/benchmark` episode plan against each
  CapabilityPack through a `WorkerAdapter`, expose macro-averaged
  `<arm>.<metric>` signals, and wire it into `mentat_dream` with
  `MENTAT_BENCH_PLAN`/`MENTAT_BENCH_DATASET`. Verified in a real DSH
  model-driven run: passphrase benchmark 0 → 1, accepted, archived.
- `mentat_dream`: operator-configured `CommandPackEvaluator` wired through
  `@mentat/evolve`, with a real DSH model-driven E2E (quality 1 → 2, accepted,
  archived).
- `MENTAT_WORKER=opencode`: dispatch Assignments through `HarnessWorker` and
  the OpenCode ACP adapter. Verified end-to-end with the OpenCode API:
  Router session → `mentat_run` → Worker report → receipt.
- `@mentat/dsh-client`: DSH client-shell Settings → Mentat page reading the
  `/mentat/overview` projection; verified in a real `dsh web` run.
- `scripts/github-source-smoke.ts`: real `gh` auth/network smoke for the
  GitHub Source (manual; not run in `pnpm check`).
- `@mentat/dsh/panel`: server-rendered `/mentat` panel with overview and
  immediate Source poll, mounted only in web profiles.
- `@mentat/panel`: read-only overview projection (`needsPerson`, open/ended
  Tickets, assignments, decisions) and a terminal renderer; exposed through
  `mentat_overview`.
- `@mentat/dsh`: mount `GitHubSource` with a `SourcePoller` driven by
  `MENTAT_GITHUB_REPO`/`MENTAT_GITHUB_AGENT`, plus a `mentat_poll` tool.
- `@mentat/source-github`: `GitHubSource` for Issue/PR/review/comment/CI
  Triggers, persisted read positions, and an `OutboxTransport` Channel over
  `gh api`.
- `@mentat/evolve`: Dream/Evolution loop with versioned pack candidates,
  injected evaluation, gate chain, Pareto acceptance, JSON pack archive and a
  durable `dream` effect on `@mentat/effects`.
- `@mentat/pack`: versioned `CapabilityPack` contract with content addressing.
  `MentatRuntime` attaches its digest to Assignments and receipts;
  `HarnessWorker` injects prompt/model/MCP/executionPolicy and rejects
  unsupported skills/memory/tool allowlists.
- Artifact identity/adapters refactor (ADR-0006): `ArtifactRef`, `Artifact`,
  `ArtifactAdapter`, `ArtifactRegistry`, canonical-JSON `Digest`, and
  content-addressed data candidates. See
  `docs/research/artifact-architecture-2026-10-22.md`.
- `@mentat/workspace`: `ArtifactStore` CAS; `JsonStoreWorkspace` persists refs
  only and rehydrates payloads by digest.
- `@mentat/evolution`: external `EvalProtocol`, `IterationReceipt`, per-iteration
  `outcome`, and niche-aware archive selection.
- `@mentat/observability`: append-only `ReceiptStore`; `evolve` and `iterate`
  now persist a protocol digest and per-iteration receipts.
- `@mentat/workspace`: `GitWorkspace` attaches a `form: "code"` artifact
  (`digest: git:<commit>`) to every candidate.
- CI: `.github/workflows/check.yml` runs the full `pnpm check` gate on push/PR.
- `docs/adr/` decision records and this changelog.
- `@mentat/observability`: `memoryAttribution()` aggregates a trajectory's
  memory operations (injections, reads, writes, reflections, history retrieval)
  for substrate-level attribution.
- `@mentat/assistant`: `reflectionTrigger()` — evidence-gated reflection policy.
- CLI `run --reflect-auto` (reflect only on a correction or reusable failures).
- `@mentat/core`: `correctiveInstruction()`; `@mentat/session`:
  `correctiveRetries` bounded corrective re-ask for invalid final answers.

### Changed
- PAST-Bench bridge emits a `memory` attribution block; adapter logs it.

### Fixed
- `@mentat/transport-pi`: a failed/aborted model call (e.g. expired API key)
  now surfaces as `run.settled` error instead of a silent empty completion.
- `@mentat/host`: states explicitly when no historical evidence matched, so the
  model abstains instead of fabricating.

### Removed
- `IterableArtifact`, `EvalSpec`, `EvalResult`, `ArtifactSnapshot` and
  `ArtifactRebuilder`. Artifacts are now immutable values with adapters.
- Dead `buildMemoryContext` (superseded by `buildTurnContext`).
- Empty `packages/runtime` leftover directory.

### Refactor
- `memory-mcp`: `server.mjs` → `loader.mjs` (it is a loader shim).
- Extracted `@mentat/harnesses` (engine registry); `@mentat/host` is now
  engine-agnostic (ADR-0004). `compat.ts` moved to the CLI.
- Split `host.ts` (585→~515 lines): `config.ts`, `policy.ts`, `readiness.ts`.
- `assistant/history.ts` reuses `memory`'s tokenizer instead of duplicating it.
- Root `tsconfig` now type-checks `scripts/**/*.ts`; dropped the redundant
  `benchmarks/tsconfig.json`.
- Layering checker verifies the allowed-deps table against real packages.

### Added (continued)
- `@mentat/benchmark`: `BridgeRegistry` + bridge-contract ADR (ADR-0005).
- In-package `@mentat/host` contract tests.
