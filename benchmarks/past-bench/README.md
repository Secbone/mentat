# PAST-Bench ↔ Mentat (minimal bridge)

Bridge that lets [PAST-Bench](https://github.com/Gen-Verse/PAST-Bench) evaluate
Mentat as the subject agent. Upstream, PAST-Bench resolves agents from a fixed
`_ADAPTERS` map; we register a Mentat adapter into that map at runtime instead of
patching the checkout.

## Files

| File | Side | Role |
|---|---|---|
| `../../scripts/past-bench-agent.ts` | Mentat | Runs one Mentat assistant host turn and prints `{final_output, usage, reason}` on stdout. |
| `mentat_adapter.py` | PAST-Bench | `_OneShotCliAdapter` that shells out to the script with the task prompt on stdin. |
| `agents.mentat.yaml` | PAST-Bench | Agent registry entry (`agent: mentat`, `adapter: mentat_cli`). |
| `run.py` | PAST-Bench | Injects the adapter into `_ADAPTERS`, then defers to the `past-bench` CLI. |

## Setup

```bash
git clone --depth 1 https://github.com/Gen-Verse/PAST-Bench.git /tmp/PAST-Bench
cd /tmp/PAST-Bench
uv venv --python 3.11 --seed .venv
UV_HTTP_TIMEOUT=300 uv pip install -p .venv -e ".[mock,sandbox,dev]"
```

Mentat side: use the repo as-is (`scripts/past-bench-agent.ts`); Node + `tsx`
come from the repo's own `node_modules`. The adapter keeps the real `HOME` so
Mentat's Pi/OpenCode credential discovery works.

## Run a single episode / a family

```bash
cd /path/to/mentat
export MENTAT_ROOT=/path/to/mentat
export MENTAT_MODEL=opencode-go/deepseek-v4.1-flash   # or any Mentat model id

PY=/tmp/PAST-Bench/.venv/bin/python

# one episode
$PY benchmarks/past-bench/run.py run \
  --task /tmp/PAST-Bench/self-evolve-tasks-v2/memory_ability/SM01_preference_adoption/cold_style_baseline \
  --agent mentat --registry benchmarks/past-bench/agents.mentat.yaml \
  --runtime local --no-judge --trace-dir /tmp/past-bench-smoke/cold

# a whole self-evolve family (cross-session)
$PY benchmarks/past-bench/run.py evolve \
  --family memory_ability/SM01_preference_adoption \
  --agent mentat --registry benchmarks/past-bench/agents.mentat.yaml \
  --runtime local --no-judge --trace-dir /tmp/past-bench-smoke/sm01
```

Required/optional env for the adapter: `MENTAT_ROOT` (required), `MENTAT_NODE`,
`MENTAT_HARNESS` (`pi|acp|fake`, default `pi`), `MENTAT_MODEL`.

## Smoke result — 2026-10-17

`memory_ability/SM01_preference_adoption` (8 episodes), `runtime=local`,
`--no-judge`, model `opencode-go/deepseek-v4.1-flash`. Artifacts:
`results/2026-10-17-sm01/`.

| bucket | avg task score | pass rate |
|---|---:|---:|
| baseline | 0.600 | 0.000 |
| learn | 0.560 | 0.000 |
| evaluation | 0.400 | 0.000 |
| control | 0.800 | 0.333 |

`family_delta = -0.200`. Episode 5 (`SM01_EVAL_FAR_001`) hit the 300 s per-task
turn timeout and was scored 0 by the infra rule. One control passed (1.000).

## Known gaps (why the delta is negative)

- The adapter is **one-shot**: one Mentat host turn per task. It does not drive
  PAST-Bench's multi-turn tool protocol.
- **No dispatch attribution**: PAST-Bench reads `dispatches`/`memory_calls`/
  `skill_calls` to attribute cross-session gains. The bridge reports none, so the
  substrate-usage evidence is empty (`memory_calls=0`, `search_calls=0`) even
  though Mentat writes memory. A proper bridge must surface Mentat memory/skill
  reads/writes as PAST-Bench dispatch events.
- The Mentat assistant host injects its own system prompt; a leaderboard-grade
  subject should pin an assistant-policy version and record it.
- Output format is a known Mentat weakness (see `docs/research/`); here the
  first-turn answers were parsed, but communication scoring was disabled
  (`--no-judge`).
