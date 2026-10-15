import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTurnContext,
  ExperienceStore,
  JsonFileMemoryStore,
  MemoryService,
} from "@mentat/memory";
import { expect, it } from "vitest";
import { rememberUserFact } from "./remember";

it("confirms a persisted candidate with evidence of the actual manual directive", () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-confirm-"));
  const path = join(dir, "memory.json");
  const experience = join(dir, "experience");
  new MemoryService(new JsonFileMemoryStore(path)).write({
    key: "weekend",
    text: "周末11点前回家",
    kind: "constraint",
    basis: "inference",
    speaker: "assistant",
  });
  expect(buildTurnContext(new JsonFileMemoryStore(path), "周末").text).toBe("");
  const result = rememberUserFact(path, experience, "周末11点前回家");
  expect(result).toMatchObject({
    op: "update",
    entry: { key: "weekend", kind: "constraint", status: "active", revision: 2 },
  });
  const records = new ExperienceStore(experience).list();
  expect(records).toHaveLength(1);
  expect(records[0]?.messages?.[0]).toMatchObject({ role: "user", text: "周末11点前回家" });
  expect(result.entry?.evidence).toBe(`exp:${records[0]?.id}#msg0`);
  expect(buildTurnContext(new JsonFileMemoryStore(path), "周末").text).toContain("周末11点前回家");
  expect(JSON.parse(readFileSync(`${path}.audit.jsonl`, "utf8").trim()).previous.status).toBe(
    "candidate",
  );
});
