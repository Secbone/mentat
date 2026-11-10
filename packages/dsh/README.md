# @mentat/dsh

Cordis plugin that hosts the Mentat control plane inside DeepSeek Harness.

## Quick start (local profile)

Build the deployable plugin entries once, and again after code changes:

```bash
pnpm build:dsh ~/.local/share/mentat/dsh
```

Point a web profile at the build and add the OpenCode route. In
`~/.dsh/profiles/mentat-web/cordis.patch.yml`:

```yaml
- insert:
    - id: mentat
      name: 'file:///home/<user>/.local/share/mentat/dsh/index.js'
    - id: mentat-panel
      name: 'file:///home/<user>/.local/share/mentat/dsh/panel.js'
    - id: mentat-client
      name: '@mentat/dsh-client'
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_API_KEY
- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
```

Keep the credential and runtime switches in `~/.dsh/.env` (mode 600):

```bash
OPENCODE_API_KEY=...
MENTAT_WORKER=opencode
MENTAT_MODEL=opencode-go/deepseek-v4.1-flash
MENTAT_STATE_DIR=/home/<user>/.local/share/mentat/state
```

Start the service:

```bash
dsh --profile mentat-web --no-open --port 3080
```

The launcher prints the authenticated Web URL. Open that URL once to receive
the signed browser cookie, then the server-rendered panel is at
`http://127.0.0.1:3080/mentat`, and its JSON projection is
`http://127.0.0.1:3080/mentat/overview`. The panel routes use DSH's Host/Origin
fence and browser authentication, so an unauthenticated request gets 401.
Stop it with:

```bash
pkill -f "dsh/lib/bin.js --profile mentat-web"
```

## Surface

- service `mentat`: `{ runtime, repos, queue, receipts }`
- tools:
  - `mentat_status` — ticket/thread/decision counts and the Router session
  - `mentat_receive` — receive a local Trigger, start due Evals, run due effects
  - `mentat_dispatch` — accept one candidate and run its Assignment
  - `mentat_overview` — person-blocked Tickets, open work, assignments and decisions
  - `mentat_dream` — propose, evaluate, gate and archive one CapabilityPack candidate
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

## Dream evaluator

`mentat_dream` is enabled by one of two operator-owned evaluators. The model
never supplies the evaluator.

### Benchmark evaluator

Run a native benchmark episode set against each pack. The pack digest is
recorded in the run plan and signals are named `<arm>.<metric>`.

```bash
export MENTAT_WORKER=opencode
export MENTAT_BENCH_PLAN=benchmarks/evolution/passphrase-plan.json
export MENTAT_BENCH_DATASET=benchmarks/evolution/passphrase-episodes.json
export MENTAT_BENCH_OUT=/tmp/mentat-bench   # optional, default <state>/bench
export MENTAT_BENCH_ARMS=reset             # optional, comma-separated
```

The fixture `benchmarks/evolution/passphrase-plan.json` is a smoke benchmark:
the base pack scores 0, and a pack carrying the passphrase lesson scores 1.

Set `MENTAT_BENCH_WORKERS=opencode,pi` to evaluate the same pack across a
Worker matrix. Signals are namespaced `<worker>.<arm>.<metric>`, so a gain on
one Worker cannot be reported as a system-wide gain; the improvement gate
requires every Worker to be no worse.

### Automatic evolution

`mentat_evolve` reads failed Assignment receipts, turns them into Dream
observations, and runs the same propose → evaluate → gate → archive loop.
Receipts already named by an archived candidate are skipped, and duplicate
lesson text is collapsed in one batch.

```bash
export MENTAT_EVOLVE_INTERVAL_MS=3600000      # optional periodic pass
export MENTAT_EVOLVE_MAX_OBSERVATIONS=5       # optional, newest first
```

The scheduler skips overlapping passes and reports failures without stopping
the next one. `mentat_evolve` also runs one pass on demand.

### Canary and rollback

`mentat_channel` inspects or changes the stable/canary pack channel:

```text
action=status
action=canary candidate=<accepted id> ratio=0.1
action=promote candidate=<accepted id>   # or omit candidate to promote the canary
action=rollback
```

Selection is deterministic per Assignment id, so a retry stays in the same
channel. Receipts record `packChannel: "stable" | "canary"`, and the channel is
persisted in `<state>/pack-channel.json` so a restart keeps the promoted pack.
The panel overview exposes the current stable/canary versions.

Set `MENTAT_CANARY_INTERVAL_MS` to check canary health periodically. The
monitor compares canary receipts since the canary started with the stable
baseline and rolls back when either threshold is crossed:

```bash
MENTAT_CANARY_INTERVAL_MS=60000
MENTAT_CANARY_MIN_SAMPLES=5          # default 5
MENTAT_CANARY_MAX_FAILURE_RATE=0.5   # absolute ceiling
MENTAT_CANARY_MAX_DELTA=0.2          # allowed regression vs stable
```

`mentat_channel action=status` includes the current assessment, and a rollback
clears the canary without touching the stable pack.

### Command evaluator

Set `MENTAT_EVAL_COMMAND` (or `config.evolve.command`). The command receives the
pack as `MENTAT_PACK` JSON plus `MENTAT_PACK_VERSION`/`MENTAT_PACK_DIGEST`, and
prints a `Signal[]` JSON array.

```bash
export MENTAT_EVAL_COMMAND='node -e "console.log(JSON.stringify([{name:"quality",value:Number(process.env.MENTAT_PACK_VERSION),direction:"higher-better"}]))"'
```

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

## Panel

The panel is a second plugin entry so headless profiles do not require a web
server. Mount both rows in a web profile:

```yaml
- insert:
    - id: mentat
      name: '@mentat/dsh'
    - id: mentat-panel
      name: '@mentat/dsh/panel'
```

Open `http://127.0.0.1:3080/mentat`. The page reads `/mentat/overview` (the
same projection as `mentat_overview`) and posts `/mentat/poll` for an immediate
Source poll. It is intentionally server-rendered and dependency-free.

For the client-shell page, also install `@mentat/dsh-client` and add its row
`@mentat/dsh-client` to the same web profile. It registers Settings → Mentat
and reads the same `/mentat/overview` contract.

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

The default Worker is `FakeWorker`. Set `MENTAT_WORKER=opencode` to dispatch
Assignments through `HarnessWorker` + the OpenCode ACP adapter, or
`MENTAT_WORKER=pi` for the Pi RPC adapter. `MENTAT_MODEL` sets the pack model
(for example `opencode-go/deepseek-v4.1-flash`). Both real model-driven paths
were verified end-to-end: Router session, `mentat_run`, Worker report `pong`,
receipt persisted with `worker: "opencode"` or `worker: "pi"`.

For a file-URL profile, build the plugin entries with:

```bash
pnpm build:dsh /tmp/mentat-dsh
```

This writes `index.js`, `panel.js`, the Pi bridge under `bridge/`, and the
client-shell package under `dsh-client/`. The bridge copy is required because
the Pi adapter resolves its extension relative to the loaded module.

Route DSH itself through the OpenCode API (no DeepSeek key needed):

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_API_KEY
- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
- insert:
    - id: mentat
      name: '@mentat/dsh'
```

```bash
export OPENCODE_API_KEY=...
export MENTAT_WORKER=opencode
dsh headless --patch <profile-patch.yml>   'Use the mentat_run tool once with text "Reply with exactly: pong".'
```
