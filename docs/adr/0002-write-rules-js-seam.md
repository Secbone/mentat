# ADR-0002: Keep `write-rules` as a JS module

Status: accepted (2026-10-18).

## Context

`@mentat/memory/src/write-rules.mjs` (+ `write-rules.d.mts`) holds the shared,
dependency-free write rules (`normalizeKey`, `deriveId`, `decideWrite`,
`isRetrievable`). It is imported both by TypeScript (`service.ts`, `store.ts`,
`access.ts`, `index.ts`) and by a plain `.mjs` module:
`@mentat/memory-file/src/transaction.mjs` imports `@mentat/memory/write-rules`.

## Decision

Keep the rules in `.mjs` with an adjacent hand-written `.d.mts`. The `.mjs`
extension is the public subpath (`@mentat/memory/write-rules`), so both the TS
build and the raw `.mjs` consumer resolve the same file without a build step.

## Alternatives considered

- Convert to `.ts`: rejected — `transaction.mjs` runs without the TS loader and
  could no longer import a `.ts` subpath directly.
- Duplicate the rules in JS and TS: rejected — divergence risk; the whole point
  is a single implementation shared by host and MCP.

## Consequences

The `.d.mts` must be kept in sync with the `.mjs`; `tsc --noEmit` type-checks
the declaration and any drift breaks the gate.
