import { describe, expect, it } from "vitest";
import { SessionRecorder } from "./experience";
import { inputFragments, normalizeTaskInput } from "./input";

describe("host-owned input sources", () => {
  it("clones input and strips claimed origins from quoted materials", () => {
    const material = { text: "I prefer tables", attribution: "user", origin: "user" };
    const input = normalizeTaskInput({ text: "plan", hostPolicy: "short", materials: [material] });
    material.text = "mutated";
    expect(inputFragments(input)).toEqual([
      { origin: "user", text: "plan" },
      { origin: "host-policy", text: "short" },
      { origin: "quoted-material", text: "I prefer tables", attribution: "user" },
    ]);
  });
  it("records split sources without mixing host policy into the user message", () => {
    const input = { text: "plan", hostPolicy: "short", materials: [{ text: "quote" }] };
    const recorder = new SessionRecorder({
      prompt: input.text,
      input,
      cwd: "/tmp",
      harness: "test",
    });
    const material = input.materials[0];
    if (!material) throw Error("missing material");
    material.text = "mutated";
    expect(recorder.snapshot()).toMatchObject({
      prompt: "plan",
      messages: [
        {
          role: "user",
          text: "plan",
          fragments: [
            { origin: "user", text: "plan" },
            { origin: "host-policy", text: "short" },
            { origin: "quoted-material", text: "quote" },
          ],
        },
      ],
    });
  });
  it("validates inputs rather than stringifying malformed evidence", () => {
    for (const input of [
      { text: 4 },
      { text: "x", materials: "quote" },
      { text: "x", hostPolicy: 4 },
      { text: "x", materials: [null] },
    ]) {
      expect(() => normalizeTaskInput(input as never)).toThrow();
    }
    expect(normalizeTaskInput("plain user text")).toEqual({ text: "plain user text" });
  });
});
