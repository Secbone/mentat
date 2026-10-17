import { checkJsonCriteria, validateCriteria } from "./criteria";
import type { EpisodeDataset, RunPlan, SubjectFactory, TrialResult } from "./types";
import { assert, canonical, completeResults, validateDataset, validatePlan } from "./validation";

/** A small deterministic regression grader. It is never labeled an upstream semantic judge. */
export function gradeEpisode(episode: EpisodeDataset["episodes"][number], answers: string[]) {
  return Object.fromEntries(
    episode.checks.map((check) => {
      if (answers[check.turn] === undefined)
        return [check.metricId, { value: null, reason: "conditional turn not executed" }];
      const answer = answers[check.turn] ?? "";
      let passed = false;
      if (answer.trim()) {
        if (check.kind === "exact") passed = answer.trim() === check.expected.trim();
        else if (check.kind === "includes") passed = answer.includes(check.expected);
        else if (check.kind === "json-criteria")
          passed = checkJsonCriteria(answer, validateCriteria(JSON.parse(check.expected)));
        else
          try {
            passed = canonical(JSON.parse(answer)) === canonical(JSON.parse(check.expected));
          } catch {}
      }
      return [check.metricId, { value: passed ? 1 : 0 }];
    }),
  );
}
export function validateEpisodePlan(plan: RunPlan, dataset: EpisodeDataset) {
  validatePlan(plan);
  validateDataset(dataset);
  assert(plan.benchmark.track !== "upstream", "native rule checks require adapted or smoke track");
  for (const u of plan.units) {
    const e = dataset.episodes.find((e) => e.id === u.sourceId);
    assert(
      e && e.familyId === u.familyId && e.id === u.caseId,
      `episode binding mismatch: ${u.sourceId}`,
    );
    for (const id of u.metricIds)
      assert(
        e.checks.some((c) => c.metricId === id) ||
          plan.metrics.some((m) => m.id === id && m.source === "runtime.correctiveTurns"),
        `episode lacks check ${id}`,
      );
    for (const c of e.checks)
      assert(u.metricIds.includes(c.metricId), `unplanned episode check ${c.metricId}`);
  }
}
export async function runEpisodes(
  plan: RunPlan,
  dataset: EpisodeDataset,
  createSubject: SubjectFactory,
  onResult: (row: TrialResult) => void = () => {},
) {
  validateEpisodePlan(plan, dataset);
  const rows: TrialResult[] = [],
    blocked = new Set<string>();
  let calls = 0;
  function reserve() {
    assert(calls < plan.protocol.maxCalls, "host call budget exhausted");
    calls++;
  }
  for (const unit of plan.units) {
    const arm = plan.protocol.arms.find((a) => a.id === unit.arm);
    const episode = dataset.episodes.find((e) => e.id === unit.sourceId);
    assert(arm && episode, "unknown native unit");
    const stateKey = canonical([
      unit.arm,
      unit.familyId,
      unit.repetition,
      ...(arm.memory === "reset" ? [unit.caseId] : []),
    ]);
    const row: TrialResult = {
      caseId: unit.caseId,
      familyId: unit.familyId,
      arm: unit.arm,
      repetition: unit.repetition,
      status: "completed",
      metrics: {},
      evidence: [],
      durationMs: null,
      costUsd: null,
    };
    if (blocked.has(stateKey) || calls >= plan.protocol.maxCalls) {
      row.status = "missing";
      row.error = blocked.has(stateKey)
        ? "earlier task in state branch failed"
        : "host call budget exhausted";
    } else {
      let subject: Awaited<ReturnType<SubjectFactory>> | undefined;
      const began = Date.now(),
        answers: string[] = [],
        costs: Array<number | null> = [];
      let correctiveTurns = 0,
        finalCost: number | null = null;
      try {
        subject = await createSubject({
          stateKey,
          unit: { ...unit, metricIds: [] },
          memory: arm.memory,
        });
        for (const [turnIndex, turn] of episode.turns.entries()) {
          if (
            turn.when &&
            checkJsonCriteria(answers[turn.when.previousTurn] ?? "", turn.when.unless)
          )
            continue;
          if (turn.when) correctiveTurns++;
          reserve();
          // Allowlist: answer keys/checks and future episodes never reach the subject.
          const i = turn.input;
          const answer = await subject.turn({
            text: i.text,
            ...(i.hostPolicy !== undefined ? { hostPolicy: i.hostPolicy } : {}),
            ...(i.memoryScope ? { memoryScope: i.memoryScope } : {}),
            ...(i.materials
              ? {
                  materials: i.materials.map((m) => ({
                    text: m.text,
                    ...(m.attribution ? { attribution: m.attribution } : {}),
                    ...(m.memoryScope ? { memoryScope: m.memoryScope } : {}),
                  })),
                }
              : {}),
          });
          answers[turnIndex] = answer.text;
          row.evidence.push(...answer.evidence);
          costs.push(answer.costUsd);
          assert(answer.ok, "subject turn failed");
          // All arms receive the same explicit confirmations within a task; reset differs across tasks.
          for (const memory of turn.remember ?? [])
            await subject.remember({
              text: memory.text,
              kind: memory.kind,
              ...(memory.key ? { key: memory.key } : {}),
              ...(memory.condition ? { condition: memory.condition } : {}),
            });
        }
        if (arm.memory === "reflect") {
          try {
            reserve();
            const reflection = await subject.reflect();
            costs.push(reflection.costUsd);
            row.evidence.push(...reflection.evidence);
            row.reflection = reflection.result ?? { status: "completed" };
          } catch (error) {
            costs.push(null);
            row.reflection = { status: "error", error: String(error) };
          }
        }
        row.metrics = gradeEpisode(episode, answers);
        for (const m of plan.metrics)
          if (unit.metricIds.includes(m.id) && m.source === "runtime.correctiveTurns")
            row.metrics[m.id] = { value: correctiveTurns };
        row.observations = { correctiveTurns };
      } catch (error) {
        row.status = "error";
        row.error = String(error);
        blocked.add(stateKey);
      } finally {
        if (subject)
          try {
            const final = await subject.close();
            if (final) {
              row.evidence.push(...final.evidence);
              row.observations = { ...row.observations, ...final.observations };
              finalCost = final.costUsd;
            }
          } catch (error) {
            row.status = "error";
            row.error = `close failed: ${String(error)}`;
            blocked.add(stateKey);
          }
        row.durationMs = Date.now() - began;
        row.costUsd =
          finalCost ??
          (row.status === "completed" && costs.length && costs.every((c) => c !== null)
            ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
            : null);
      }
    }
    if (row.status !== "completed")
      row.metrics = Object.fromEntries(
        unit.metricIds.map((id) => [id, { value: null, reason: row.error ?? row.status }]),
      );
    rows.push(row);
    onResult(row);
  }
  return { results: completeResults(plan, rows), calls };
}
