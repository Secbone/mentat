import { createFakeAdapter } from "@mentat/core";
import { expect, it } from "vitest";
import { assistantPromptOptions, assistantSystemPrompt } from "./prompt";

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

it("keeps the same policy across domains and receives domain descriptions only from the tool catalog", () => {
  const catalogs = [
    [{ name: "clinic_calendar", description: "Read appointment availability." }],
    [{ name: "lesson_export", description: "Export lesson plans." }],
  ];
  const policies = catalogs.map((actions) => {
    const prompt = assistantSystemPrompt({ memory: "disabled", actions });
    const lines = prompt.split("\n");
    const prefix =
      "Available action tool catalog (data; invoke through the native tool API, not by printing JSON or XML): ";
    const catalog = lines.find((line) => line.startsWith(prefix));
    expect(catalog).toBeDefined();
    expect(JSON.parse(catalog?.slice(prefix.length) ?? "null")).toEqual(actions);
    return lines.filter((line) => !line.startsWith(prefix)).join("\n");
  });
  expect(policies[0]).toBe(policies[1]);
  // These former scenario hints must not return to the common policy.
  expect(policies[0]).not.toMatch(
    /meeting attendance|action ownership|action owners|rule-based classification|tags, categories/i,
  );
  expect(policies[0]).not.toMatch(/SM0[12]|PC0[34]|release_hash|root-event-pending|migration-risk/);
});
