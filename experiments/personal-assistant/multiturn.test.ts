import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { explicitRules } from "./explicit-rules";
import { memoryLocation, modelInput, scoreAnswer } from "./multiturn";

test("model inputs contain user turns but never hidden checks", () => {
  const input = modelInput("教师", {
    text: "给家长写反馈",
    remember: false,
    checks: [{ name: "hidden-rubric", patterns: ["secret-evaluator"] }],
  });
  const text = JSON.stringify(input);
  assert.equal(input.text, "给家长写反馈");
  assert.equal(input.memoryScope, "unspecified");
  assert.ok(input.hostPolicy?.includes("220字"));
  assert.ok(!text.includes("hidden-rubric"));
  assert.ok(!text.includes("secret-evaluator"));
});
test("reset changes memory per task while persistent arm reuses it", () => {
  assert.equal(
    memoryLocation("/tmp", "a", "persistent", "learn"),
    memoryLocation("/tmp", "a", "persistent", "transfer"),
  );
  assert.notEqual(
    memoryLocation("/tmp", "a", "reset", "learn"),
    memoryLocation("/tmp", "a", "reset", "transfer"),
  );
});
test("empty responses cannot pass checks and checks need every pattern", () => {
  assert.equal(scoreAnswer("", [{ name: "empty", patterns: [] }])[0]?.passed, false);
  assert.equal(
    scoreAnswer("结论风险", [{ name: "sections", patterns: ["结论", "依据", "风险"] }])[0]?.passed,
    false,
  );
});
test("frozen dataset has the planned task and explicit-confirmation boundaries", () => {
  const cases = JSON.parse(
    readFileSync(new URL("./multiturn-cases.json", import.meta.url), "utf8"),
  );
  assert.equal(cases.scenarios.length, 4);
  let confirmations = 0;
  for (const scenario of cases.scenarios) {
    assert.equal(scenario.tasks.length, 3);
    for (const task of scenario.tasks) {
      assert.equal(task.turns.length, 4);
      for (const turn of task.turns)
        if (turn.remember) {
          assert.equal(task.id, "learn");
          assert.match(turn.text, /请长期记住/);
          const typed = explicitRules(scenario.id, turn.text);
          assert.ok(typed.every((r) => typeof r !== "string" && turn.text.includes(r.text)));
          assert.ok(typed.some((r) => typeof r !== "string" && r.kind === "constraint"));
          confirmations++;
        }
    }
  }
  assert.equal(confirmations, 4);
});

test("ordered preference checks reject reversed headings", () => {
  assert.equal(
    scoreAnswer("风险 依据 结论", [
      { name: "order", patterns: ["结论", "依据", "风险"], ordered: true },
    ])[0]?.passed,
    false,
  );
  assert.equal(
    scoreAnswer("结论 依据 风险", [
      { name: "order", patterns: ["结论", "依据", "风险"], ordered: true },
    ])[0]?.passed,
    true,
  );
});

test("pressure counterfactual distinguishes semantic rules from typed constraints", async () => {
  const { pressureProbe } = await import("./multiturn-pressure");
  const probe = pressureProbe({
    id: "deadline",
    text: "必须11点前回家",
    kind: "fact",
    status: "active",
    basis: "user",
    createdAt: 1,
  });
  assert.equal(probe.observed.selected, false);
  assert.equal(probe.observed.required, false);
  assert.equal(probe.typedCounterfactual.selected, true);
  assert.equal(probe.typedCounterfactual.required, true);
});
