# @mentat/dsh

Cordis plugin that hosts the Mentat control plane inside DeepSeek Harness.

## Surface

- service `mentat`: `{ runtime, repos, queue, receipts }`
- tools:
  - `mentat_status` — ticket/thread/decision counts and the Router session
  - `mentat_receive` — receive a local Trigger, start due Evals, run due effects
  - `mentat_dispatch` — accept one candidate and run its Assignment
  - `mentat_poll` — poll the configured Source now
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

## GitHub Source

Set these to mount the GitHub Source and a periodic poll:

```bash
MENTAT_GITHUB_REPO=owner/name
MENTAT_GITHUB_AGENT=mentat-bot
MENTAT_GITHUB_POLL_MS=60000   # optional
```

`GitHubSource` uses `gh api` repository events; the read position is stored in
`<state>/github-state.json`. `SourcePoller` starts with the plugin and is
stopped by the plugin effect. `mentat_poll` triggers one immediate poll.

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
