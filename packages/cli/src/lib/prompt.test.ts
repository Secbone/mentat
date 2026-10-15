import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { JsonFileMemoryStore } from "@mentat/memory";
import { createPiAdapter } from "@mentat/transport-pi";
import { describe, expect, it } from "vitest";
import { assistantPromptOptions, taskContext } from "./prompt";

describe("host context", () => {
  it("reloads tool-written memories between turns, even without keyword overlap", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mentat-context-")), "memory.json");
    expect(taskContext(path, "出门办事")).toBe("");
    new JsonFileMemoryStore(path).add({ id: "deadline", text: "周末11点前回家", createdAt: 1 });
    expect(taskContext(path, "出门办事")).toContain("周末11点前回家");
  });

  it("requests replacement only from a supporting harness", () => {
    expect(assistantPromptOptions(createPiAdapter()).systemPromptMode).toBe("replace");
    expect(assistantPromptOptions(createFakeAdapter()).systemPromptMode).toBe("append");
  });

  it("blocks a turn when mandatory memories exceed the context budget", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mentat-context-")), "memory.json");
    new JsonFileMemoryStore(path).add({
      id: "deadline",
      text: "11点前回家".repeat(2000),
      kind: "constraint",
      createdAt: 1,
    });
    expect(() => taskContext(path, "出门办事")).toThrow(/required constraints/);
  });
});
