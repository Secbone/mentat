# Changelog

Notable changes. Loosely follows [Keep a Changelog](https://keepachangelog.com/).
Authoritative architecture decisions live in [`docs/adr/`](docs/adr/); the
milestone list in [`docs/plan.md`](docs/plan.md) is historical background.

## Unreleased

### Added
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
- Dead `buildMemoryContext` (superseded by `buildTurnContext`).
- Empty `packages/runtime` leftover directory.

### Refactor
- `memory-mcp`: `server.mjs` → `loader.mjs` (it is a loader shim).
