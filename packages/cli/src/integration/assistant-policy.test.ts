import { assistantPromptOptions } from "@mentat/assistant";
import { createFakeAdapter } from "@mentat/core";
import { createPiAdapter } from "@mentat/transport-pi";
import { expect, it } from "vitest";

it("requests replacement only from a supporting harness", () => {
  expect(assistantPromptOptions(createPiAdapter()).systemPromptMode).toBe("replace");
  expect(assistantPromptOptions(createFakeAdapter()).systemPromptMode).toBe("append");
});
