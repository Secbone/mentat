import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dataset = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const scenarios = [...dataset.scenarios, ...dataset.implicitScenarios];

function validate() {
  assert.equal(dataset.version, 1);
  assert.equal(dataset.synthetic, true);
  const ids = new Set();
  let count = 0;
  for (const scenario of scenarios) {
    assert.match(scenario.id, /^[a-z]+(?:-[a-z]+)*$/);
    assert(!ids.has(scenario.id), `duplicate scenario: ${scenario.id}`);
    ids.add(scenario.id);
    assert(scenario.evaluatorProfile.initialPreferences.length > 0);
    const phases = scenario.phaseOrder ?? dataset.phaseOrder;
    assert.equal(scenario.episodes.length, phases.length);
    let previousDay = 0;
    for (const [index, episode] of scenario.episodes.entries()) {
      assert.equal(episode.id, String(index + 1).padStart(2, "0"));
      assert.equal(episode.phase, phases[index]);
      assert(episode.simulatedDay >= previousDay);
      previousDay = episode.simulatedDay;
      assert(episode.input.prompt.trim());
      assert(episode.input.source.trim());
      for (const dimension of ["objective", "personalization", "critical"]) {
        assert(Array.isArray(episode.rubric[dimension]));
        for (const item of episode.rubric[dimension]) assert(item.trim());
      }
      assert(episode.rubric.objective.length > 0);
      assert(episode.rubric.critical.length > 0);
      if (episode.phase === "learn" || episode.phase === "observe") {
        assert(episode.afterResponseFeedback?.trim());
        assert.equal(episode.rubric.personalization.length, 0);
        assert(episode.revisionRubric.personalization.length > 0);
      } else {
        assert.equal(episode.afterResponseFeedback, null);
        assert.equal(episode.revisionRubric, null);
      }
      count += 1;
    }
  }
  assert.equal(dataset.scenarios.length, 7);
  assert.equal(dataset.implicitScenarios.length, 3);
  assert.equal(ids.size, 10);
  assert.equal(count, 82);
  return { scenarios: ids.size, episodes: count };
}

const counts = validate();
const [command, output, scenarioId, episodeId] = process.argv.slice(2);
if (command === "validate") {
  console.log(`Validated ${counts.scenarios} scenarios and ${counts.episodes} episodes.`);
} else if (command === "prepare") {
  assert(output && scenarioId && episodeId, "prepare <new-output-dir> <scenario> <episode>");
  const scenario = scenarios.find((item) => item.id === scenarioId);
  assert(scenario, `unknown scenario: ${scenarioId}`);
  const episode = scenario.episodes.find((item) => item.id === episodeId);
  assert(episode, `unknown episode: ${episodeId}`);
  const root = resolve(output);
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  assert(!root.startsWith(repository), "prepare outside the repository to separate task materials");
  // A new directory prevents silently overwriting another arm or trial.
  mkdirSync(root);
  for (const folder of ["agent", "operator", "evaluator"]) mkdirSync(resolve(root, folder));
  const writeJson = (folder, name, value) =>
    writeFileSync(resolve(root, folder, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const userTask = {
    user: { name: scenario.name, role: scenario.role },
    simulatedDay: episode.simulatedDay,
    ...episode.input,
    delivery: "根据给定的合成材料完成任务；输出答复或草稿，不执行真实发送、购买或排会。",
  };
  // The agent bundle contains only this episode; future tasks and answers stay outside it.
  writeJson("agent", "task.json", userTask);
  writeJson("operator", "feedback.json", {
    afterInitialResponse: episode.afterResponseFeedback,
    instruction: "有反馈时，在首次答复后作为同一会话的新用户消息发送；保留修订前后结果。",
  });
  writeJson("evaluator", "rubric.json", {
    scenario: scenario.id,
    episode: episode.id,
    phase: episode.phase,
    profile: scenario.evaluatorProfile,
    ...episode.rubric,
    revisionRubric: episode.revisionRubric,
  });
  writeJson("evaluator", "score.json", {
    status: "unscored",
    scenario: scenario.id,
    episode: episode.id,
    arm: null,
    seed: null,
    checkpoint: null,
    objective: episode.rubric.objective.map((criterion) => ({
      criterion,
      score: null,
      evidence: null,
    })),
    personalization: episode.rubric.personalization.map((criterion) => ({
      criterion,
      score: null,
      evidence: null,
    })),
    critical: episode.rubric.critical.map((criterion) => ({
      criterion,
      passed: null,
      evidence: null,
    })),
    firstUsable: null,
    correctiveTurns: null,
    unnecessaryQuestions: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    wallTimeMs: null,
    toolErrors: null,
    learnedMemoryEvidence: [],
    activationEvidence: null,
    revisionScores: null,
    notes: null,
  });
  console.log(`Prepared ${scenarioId}/${episodeId} in ${root}`);
} else {
  console.log(
    "Usage:\n  node experiments/personal-assistant/prepare.mjs validate\n  node experiments/personal-assistant/prepare.mjs prepare <new-output-dir> <scenario> <episode>",
  );
  process.exitCode = 1;
}
