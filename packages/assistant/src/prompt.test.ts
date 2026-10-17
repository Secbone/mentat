import { createFakeAdapter } from "@mentat/core";
import { expect, it } from "vitest";
import { assistantPromptOptions } from "./prompt";

it("advertises only the explicitly available memory actions", () => {
  const adapter = createFakeAdapter();
  const closed = assistantPromptOptions(adapter, { memory: "disabled" }).systemPrompt;
  expect(closed).toContain("Memory tools are unavailable");
  expect(closed).not.toContain("memory_search");
  expect(closed).not.toContain("memory_add");
  const read = assistantPromptOptions(adapter, {
    memory: "read-only",
    searchName: "catalog_lookup",
  }).systemPrompt;
  expect(read).toContain("catalog_lookup");
  expect(read).toContain("read-only");
  expect(read).not.toContain("memory_add");
  expect(assistantPromptOptions(adapter, { memory: "read-write" }).systemPrompt).toContain(
    "unconfirmed candidates",
  );
});
