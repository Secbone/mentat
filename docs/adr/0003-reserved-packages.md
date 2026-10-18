# ADR-0003: Reserved packages (`kernel`, `models`)

Status: accepted (2026-10-18).

## Context

- `@mentat/kernel` (plugin lifecycle / service container) is imported by
  production code only in `@mentat/evolution/src/evaluator.ts`; it is otherwise
  exercised by tests.
- `@mentat/models` (catalog / selection / model artifact) has **no production
  importer** anywhere in the repo.

Both were legitimate capability packages in the plan, but risk becoming
"reserved" dead weight.

## Decision

- Keep both packages as **reserved extension surface**; do not delete.
- Remove any **unused dependency declaration** that would make a consumer look
  coupled (e.g. drop `@mentat/models` from `@mentat/cli` if the CLI does not
  import it). The dependency-hygiene check enforces this.
- Revisit before the next major version: either wire them in (models into the
  harness/CLI path; kernel into the plugin host) or delete them.

## Consequences

The dependency check reports declared-but-unused workspace deps, so a reserved
package cannot silently stay wired into the CLI. The packages still count toward
typecheck and layering.
