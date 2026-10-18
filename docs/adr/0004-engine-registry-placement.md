# ADR-0004: Engine registry lives outside `host`

Status: accepted (2026-10-18).

## Context

`@mentat/host` is the default wiring/orchestration package. It currently bundles
`registry.ts` (`createDefaultRegistry`), which imports **both**
`@mentat/transport-pi` and `@mentat/transport-acp`. That makes the host package
depend on concrete engines, contradicting the "domain packages are
engine-agnostic" invariant, and couples the host to every future engine.

`compat.ts` (filesystem convenience: `taskContext`, `rememberUserFact`,
`saveReflections`) is likewise not host orchestration.

## Decision

- Move the engine registry into a dedicated `@mentat/harnesses` package that
  depends on `@mentat/core`, `@mentat/transport-pi` and `@mentat/transport-acp`.
- Move the filesystem convenience helpers (`compat.ts`) to the CLI (they are
  test/app conveniences, not host orchestration).
- `@mentat/host` keeps orchestration only and depends on `core`, `session`,
  `assistant`, `memory`, `memory-file`, `memory-mcp`, `observability`.

## Consequences

`host` becomes engine-agnostic; adding an engine touches `@mentat/harnesses`
(and the CLI), not `host`. Callers importing `createDefaultRegistry` from
`@mentat/host` must import it from `@mentat/harnesses` instead.
