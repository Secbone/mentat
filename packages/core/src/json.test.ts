import { describe, expect, it } from "vitest";
import { extractJson } from "./json";

describe("extractJson", () => {
  it("pulls JSON out of a fenced block", () => {
    expect(extractJson('here:\n```json\n[{"a":1}]\n```\ndone')).toEqual([{ a: 1 }]);
  });

  it("pulls bare JSON out of surrounding text", () => {
    expect(extractJson('noise {"a": 1} trailing')).toEqual({ a: 1 });
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("nothing here")).toThrow(/no JSON/);
  });
});
