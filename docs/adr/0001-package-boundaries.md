# ADR-0001: Package boundaries and dependency direction

Status: accepted (2026-10-15, enforced since).

## Context

The framework spans protocol, domain rules, file persistence, execution,
observability and multiple engine adapters. Without enforced boundaries these
converge into a few large "misc" packages.

## Decision

- `@mentat/core` and `@mentat/memory` have **zero workspace dependencies**.
- Every other package declares a **single functional responsibility** and an
  explicit, acyclic set of allowed workspace dependencies.
- `transport-*` depend only on `@mentat/core`.
- Domain packages do not bind a concrete engine; assembly is the job of the
  wiring layer plus the CLI.
- Cross-package imports go through public entrypoints only.

The rules are recorded in [`../dev-rules/layering.md`](../dev-rules/layering.md)
and enforced by `scripts/check-layering.mjs` (AST-based) inside `pnpm check`.

## Consequences

Adding a package or an import requires updating `ALLOWED_WORKSPACE_DEPS` in the
checker; drift (declared-but-unused or used-but-undeclared deps) is reported.
See ADR-0004 for keeping the engine registry out of `host`.
