# @mentat/evolve

Dream and CapabilityPack evolution.

```
observe → propose → evaluate → gate → archive
```

- `RulePackProposer` turns failure/correction observations into a new pack
  version with a reusable lesson block.
- `PackEvaluator` is injected: a benchmark, a paired task suite, or a manual
  evaluator. Evolution never declares its own score.
- `improvementGate` requires a Pareto improvement; `maxSignalGate` adds a
  ceiling; `GateChain` composes gates.
- `PackArchive` keeps every candidate, accepted or not, and persists to JSON
  under a file lock.
- `DreamService` is the offline entry point.
- `enqueueDream` / `registerDream` run one Dream pass as a durable
  `@mentat/effects` job, so a restart does not lose it.

```ts
const loop = new EvolutionLoop({
  proposer: new RulePackProposer(),
  evaluator: benchmarkEvaluator,
  gates: new GateChain([improvementGate(), maxSignalGate("cost", 0.5)]),
  archive: new PackArchive("/state/packs.json"),
});
const result = await new DreamService(loop).dream(basePack, observations);
```

The evaluator is the trust boundary: `@mentat/evolve` does not know how a pack
is scored, and the archive records the exact base/candidate signals and gate
result. DSH scheduling (`ctx.schedule`/`ctx.jobs`) and a model-backed proposer
land in the runtime plugin.
