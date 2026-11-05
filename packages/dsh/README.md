# @mentat/dsh

Cordis plugin that hosts the Mentat control plane inside DeepSeek Harness.

## Surface

- service `mentat`: `{ runtime, repos, queue, receipts }`
- tools:
  - `mentat_status` — ticket/thread/decision counts and the Router session
  - `mentat_receive` — receive a local Trigger, start due Evals, run due effects
  - `mentat_dispatch` — accept one candidate and run its Assignment
  - `mentat_run` — receive → evaluate → dispatch one local request end-to-end

`mentat_run` starts the Router lazily. The DSH agent factory is registered by
`dsh-agent-loop` after plugin startup, so creating an Agent in `apply()` races
the factory; the first tool call is safe. The plugin injects both `tools` and
`agents`.

## Capability Pack

The runtime runs one `CapabilityPack` per Assignment. `@mentat/pack` freezes
the prompt/model/tools/policy bundle and its digest is stored on the Assignment
and in the receipt. `HarnessWorker` injects prompt, model, MCP servers,
execution policy and timeout; unsupported pack capabilities fail explicitly.

## State

`MENTAT_STATE_DIR` selects the state directory (default
`<cwd>/.mentat/superagent`):

- `state/state.json` — control-plane records
- `effects.json` — durable effects
- `receipts.jsonl` — one Assignment receipt per line

## Mount

```yaml
- insert:
    - id: mentat
      name: '@mentat/dsh'
```

The spike in `experiments/dsh-spike` validates the same mounting path and
`ctx.agents.create` on DSH `0.2.1-rc.5`.

The default Worker is `FakeWorker`; a real OpenCode/Pi Worker is injected by
the runtime composition when configured.
