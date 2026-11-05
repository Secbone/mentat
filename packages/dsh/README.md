# @mentat/dsh

Cordis plugin that hosts the Mentat control plane inside DeepSeek Harness.

This is the first vertical slice: it provides a `mentat` service and a
`mentat_status` tool, backed by in-memory repositories. Persistence, the
Router/Worker loop and the panel land in later slices.

## Mount in DSH

Build the workspace package, then insert it through a profile patch:

```yaml
- insert:
    - id: mentat
      name: '@mentat/dsh'
```

Or use a local path while developing:

```yaml
- insert:
    - id: mentat
      name: 'file:///absolute/path/to/packages/dsh/src/index.ts'
```

DSH loads TypeScript plugin entries through its runtime; the spike in
`experiments/dsh-spike` validates the same mounting path on DSH `0.2.1-rc.5`.

## Surface

- service `mentat`: `{ engine, repos }`
- tool `mentat_status`: current ticket/thread/decision counts

The engine is the single writer of Triggers, Threads, Evals, Decisions,
Tickets and Assignments. See `docs/research/mentat-on-dsh-2026-11-05.md`.
