import { mkdtempSync, writeFileSync } from "node:fs";
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
