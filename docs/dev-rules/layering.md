# Layering rules

> Enforced by [`scripts/check-layering.mjs`](../../scripts/check-layering.mjs)
> (`pnpm check:layering`). Aliases are generated from package manifests by
> [`scripts/gen-aliases.mjs`](../../scripts/gen-aliases.mjs) (`pnpm gen`), so a
> new package or subpath is registered in exactly one place.

## Packages

| Package | Role | May depend on |
|---|---|---|
| `@mentat/core` | Pure engine: kernel, loop, events, artifact, adapters, model | *(nothing — zero workspace deps, no `node:` imports)* |
| `@mentat/memory` | Memory domain: stores, artifacts, evolution, experience, reflection, MCP server | `@mentat/core` |
| `@mentat/runtime` | Engine-agnostic execution: git/data workspaces, gates, evaluators, proposers, tracer | `@mentat/core` |
| `@mentat/transport-pi` | Pi RPC adapter | `@mentat/core` |
| `@mentat/transport-acp` | Generic ACP adapter | `@mentat/core` |
| `@mentat/cli` | Assembly + commands | everything above |

## Invariants

1. **`@mentat/core` stays pure.** No workspace dependencies and no `node:`
   imports. Anything that touches the filesystem, spawns a process, or is
   engine-specific lives outside core. This is what makes the kernel portable
   and cheap to test.
2. **`@mentat/memory` and `@mentat/runtime` are siblings.** Neither imports the
   other. Shared helpers that both need (e.g. `extractJson`) live in
   `@mentat/core`.
3. **`@mentat/runtime` is engine-agnostic.** It must not import any
   `transport-*` package. The CLI owns the wiring between a proposer/evaluator
   and a concrete engine.
4. **`transport-*` depend only on `@mentat/core`.** Each engine adapter must
   pass the shared contract tests in `@mentat/core/testing`
   (`describeHarnessContract`).
5. **`@mentat/cli` assembles.** It is the only package allowed to depend on
   transports plus memory and runtime.

## Dependency direction

```
        ┌──────────────┐
        │ @mentat/core │  (leaf, pure)
        └──────▲───────┘
   ┌───────────┼───────────┬──────────────┐
   │           │           │              │
memory     runtime    transport-pi   transport-acp
   └───────────┴───────────┴──────────────┘
                   ▲
                   │
                @mentat/cli
```

## Adding an engine or domain

- **New engine**: create `packages/transport-<id>`, depend only on
  `@mentat/core`, and implement `HarnessAdapter`. Run `pnpm gen` so the alias is
  registered, then pass its contract test. Register it in
  `packages/cli/src/lib/registry.ts`.
- **New domain package**: add it to `ALLOWED_WORKSPACE_DEPS` in
  `scripts/check-layering.mjs` and to this document, then run `pnpm gen`.

## Verification

`pnpm check` runs the full gate:

```bash
pnpm gen && pnpm check:layering && pnpm typecheck && pnpm test && pnpm lint
```
