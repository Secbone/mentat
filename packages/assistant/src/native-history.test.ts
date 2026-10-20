import type { ExperienceRecord } from "@mentat/session";
import { describe, expect, it } from "vitest";
import { nativeContext } from "./native-history";

const record = (patch: Partial<ExperienceRecord> = {}): ExperienceRecord => ({
  id: "native-a",
  ts: 10,
  cwd: "/old-session",
  scope: "alice",
  harness: "fake",
  prompt: "delivery updates",
  outcome: "done",
  tools: [],
  toolErrors: 0,
  messages: [
    {
      role: "user",
      text: "mixed rendering",
      fragments: [
        {
          origin: "user",
          text: "For future delivery updates, put blockers first.",
          memoryScope: "reusable",
        },
        { origin: "host-policy", text: "delivery HOST-ONLY" },
        { origin: "quoted-material", text: "delivery THIRD-PARTY", memoryScope: "task" },
      ],
    },
    { role: "assistant", text: "My delivery suggestion is optional." },
  ],
  ...patch,
});

describe("native interaction recall", () => {
  it("recalls original scoped user fragments and preserves assistant attribution without re-ingesting materials", () => {
    const source = record();
    const before = structuredClone(source);
    const result = nativeContext([source], "delivery updates", {
      maxChars: 3000,
      cwd: "/new-session",
      scope: "alice",
    });
    const messages = result.text.split("\n").map((line) => JSON.parse(line));
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "For future delivery updates, put blockers first.",
        sourceMemoryScope: "reusable",
        scope: "alice",
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "My delivery suggestion is optional.",
      }),
    );
    expect(result.text).not.toContain("HOST-ONLY");
    expect(result.text).not.toContain("THIRD-PARTY");
    expect(source).toEqual(before);
  });

  it("isolates scopes, imports, future records and legacy mixed user prompts", () => {
    const foreign = record({ id: "foreign", scope: "bob" });
    const imported = record({ id: "imported", imported: { source: "fixture", sessionId: "x" } });
    const legacy = record({
      id: "legacy",
      messages: [{ role: "user", text: "delivery LEGACY-MIXED" }],
    });
    const future = record({ id: "future", ts: 20 });
    const result = nativeContext([foreign, imported, legacy, future], "delivery", {
      maxChars: 3000,
      cwd: "/new",
      scope: "alice",
      before: 15,
    });
    expect(result.text).toBe("");
    expect(result.excludedMessages).toBe(1);
  });

  it("allows unscoped native data only in its original workspace", () => {
    const source = record({ scope: undefined, cwd: "/workspace" });
    expect(nativeContext([source], "delivery", { maxChars: 3000, cwd: "/other" }).text).toBe("");
    expect(
      nativeContext([source], "delivery", { maxChars: 3000, cwd: "/workspace" }).text,
    ).toContain("blockers first");
  });

  it("keeps a whole instruction including its trailing exception or omits it entirely", () => {
    const content = `Delivery updates: ${"check facts ".repeat(150)}Except Fridays: put the compliance check first.`;
    const source = record({
      messages: [
        {
          role: "user",
          text: content,
          fragments: [{ origin: "user", text: content, memoryScope: "task" }],
        },
      ],
    });
    const large = nativeContext([source], "delivery", {
      maxChars: 4000,
      cwd: "/new",
      scope: "alice",
    });
    expect(JSON.parse(large.text).content).toBe(content);
    expect(JSON.parse(large.text).sourceMemoryScope).toBe("task");
    expect(
      nativeContext([source], "delivery", { maxChars: 400, cwd: "/new", scope: "alice" }).text,
    ).toBe("");
  });
});
