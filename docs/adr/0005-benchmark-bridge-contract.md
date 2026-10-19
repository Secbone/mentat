# ADR-0005: Benchmark bridge contract

Status: accepted (2026-10-18).

## Context

`@mentat/benchmark` already defines the pure evaluation contracts (`RunPlan`,
`BenchmarkSubject`, `ResultAdapter`), and `@mentat/benchmark-file` ships a
`ResultAdapterRegistry`. But bridging an *upstream* dataset (PAST-Bench,
RSI-Exam, AgentDojo, …) was bespoke: each set's runner, environment, subject
adapter and integration state lived only in prose. That made progress
unmeasurable and easy to overstate.

## Decision

Add a pure `BenchmarkBridge` description + `BridgeRegistry` to
`@mentat/benchmark` (`bridges.ts`). A bridge records:

- `id` (must match `BENCHMARK_CATALOG`), `source`, pinned `revision`;
- `runner` (`native | harbor | upstream | benchflow`);
- `home` (repo directory holding assets + subject adapter);
- `resultAdapter` id used to import per-trial results;
- `integration`, an ordered ladder:
  `catalogued → source-audited → pipeline-smoke → subject-bridged → full-run`.

A level is only claimed with evidence. `defaultBridges()` states the current
truth: LongMemEval `full-run`; PAST-Bench / RSI-Exam / AgentDojo
`pipeline-smoke`; the rest `catalogued`.

## Alternatives considered

- Encode bridge state only in docs: rejected — not checkable, drifts.
- Merge into `BENCHMARK_CATALOG`: rejected — the catalog is selection policy
  (what we intend to run); a bridge is run state (how far it is).

## Consequences

Bridges become listable/checkable (`defaultBridges()`), and a set cannot be
reported as runnable without naming its runner, home and result adapter. The
registry stays in the pure `benchmark` package (no I/O); actual runners remain
in `benchmark-file`, upstream checkouts and `benchmarks/`.
