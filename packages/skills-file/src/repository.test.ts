import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileSkillRepository } from "./index";

const draft = {
  name: "triage",
  description: "Triage operational alerts",
  applicability: "Alerts with observed outcomes",
  content: "1. Inspect evidence. 2. Classify. 3. Verify updates.",
  evidence: "Observed a confirmed error and successful correction.",
  scope: "user-a",
};
it("persists scoped procedures and requires an exact current version before replacement", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-skills-")), "skills.json");
  const first = new FileSkillRepository(path);
  expect(first.save(draft, 0)).toMatchObject({ version: 1, origin: "agent-procedure" });
  const second = new FileSkillRepository(path);
  expect(second.get("triage", "user-b")).toBeUndefined();
  expect(second.get("triage", "user-a")?.content).toBe(draft.content);
  expect(() => second.save({ ...draft, content: "stale replacement" }, 0)).toThrow(
    "version conflict",
  );
  const updated = second.save({ ...draft, content: "Updated workflow" }, 1);
  expect(updated.version).toBe(2);
  expect(first.list("user-a")).toEqual([updated]);
  expect(() => first.save({ ...draft, name: "../escape" }, 0)).toThrow("invalid skill name");
});
it("fails closed on corruption instead of replacing procedural evidence", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-skills-corrupt-")), "skills.json");
  writeFileSync(path, '{"schemaVersion":1,"entries":[{"name":"corrupt"}]}');
  const repository = new FileSkillRepository(path);
  expect(() => repository.list()).toThrow();
  expect(() => repository.save(draft, 0)).toThrow();
});

it("keeps agent revisions as drafts and requires host-owned evaluation evidence to publish", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-skills-publish-")), "skills.json");
  const repo = new FileSkillRepository(path);
  expect(repo.save(draft, 0).status).toBe("draft");
  expect(() =>
    repo.review(draft.name, draft.scope, 1, {
      status: "validated",
      evaluation: { id: "eval", passed: false, evidence: ["trace"] },
    }),
  ).toThrow("passing evaluation");
  const skill = repo.review(draft.name, draft.scope, 1, {
    status: "validated",
    evaluation: { id: "eval", passed: true, evidence: ["trace"] },
  });
  expect(skill.status).toBe("validated");
  expect(repo.save({ ...draft, content: "new unverified steps" }, 2).status).toBe("draft");
  expect(readdirSync(`${path}.versions`)).toHaveLength(2);
  expect(repo.history(draft.name, draft.scope).map((skill) => skill.version)).toEqual([1, 2, 3]);
  expect(repo.restore(draft.name, draft.scope, 1, 3)).toMatchObject({
    version: 4,
    status: "draft",
    content: draft.content,
  });
  expect(() => repo.restore(draft.name, "other", 1, 4)).toThrow("version not found");
});
