# DSH plugin spike

Minimal Cordis plugin used to validate the DSH integration surface before
building Mentat on top of it. It is intentionally not part of `packages/`.

## What it proves

- A local plugin can be mounted with a `--patch` overlay without modifying the
  DSH installation.
- A plugin can provide a service (`ctx.provide("mentatSpike", ...)`).
- A plugin can register a model-facing tool (`ctx.tools.register`).
- The registered tool appears in `ctx.tools.schemas()` and the service is
  readable through `ctx.get`.

## Run

```bash
dsh --profile web --patch experiments/dsh-spike/spike.patch.yml --dump-config
dsh headless --patch experiments/dsh-spike/spike.patch.yml "reply with pong"
```

The headless run reaches the model call and fails with `MISSING_CREDENTIAL`
unless a provider key is configured; the spike logs appear before that failure:

```text
[mentat-spike] loaded
[mentat-spike] tools [ 'mentat_ping' ]
[mentat-spike] service pong
```

Verified on DSH `0.2.1-rc.5`, Node `26.8.1`, 2026-11-05.

## Agent factory probe

`agent-probe.js` verifies that `ctx.agents.create` works in the same profile
without making a model call. The factory is registered by `dsh-agent-loop`
after startup, so a plugin must not create an Agent in `apply()`; defer it to
the first tool call or a later tick.

```bash
dsh headless --patch experiments/dsh-spike/agent-probe.patch.yml "say hi"
```

Observed on DSH `0.2.1-rc.5`:

```text
[agent-probe] created probe-session-1
[agent-probe] disposed
```
