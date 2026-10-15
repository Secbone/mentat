import type { Signal } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { dominates, paretoFront, scoreOf } from "./pareto";

const higher = (name: string, value: number): Signal => ({
  name,
  value,
  direction: "higher-better",
});
const lower = (name: string, value: number): Signal => ({
  name,
  value,
  direction: "lower-better",
});

describe("dominates", () => {
  it("treats strictly greater (higher-better) as dominant", () => {
    expect(dominates([higher("a", 2)], [higher("a", 1)])).toBe(true);
    expect(dominates([higher("a", 1)], [higher("a", 2)])).toBe(false);
  });

  it("treats lower as better under lower-better", () => {
    expect(dominates([lower("cost", 1)], [lower("cost", 5)])).toBe(true);
  });

  it("requires no metric to be worse", () => {
    expect(dominates([higher("a", 2), higher("b", 1)], [higher("a", 1), higher("b", 2)])).toBe(
      false,
    );
  });

  it("ignores metrics only present on one side", () => {
    expect(dominates([higher("a", 2), higher("extra", 0)], [higher("a", 1)])).toBe(true);
  });

  it("is false for identical vectors", () => {
    expect(dominates([higher("a", 1)], [higher("a", 1)])).toBe(false);
  });
});

describe("paretoFront", () => {
  it("keeps only non-dominated members", () => {
    const front = paretoFront([
      [higher("a", 3), higher("b", 1)],
      [higher("a", 1), higher("b", 3)],
      [higher("a", 0), higher("b", 0)],
    ]);
    expect(front).toEqual([0, 1]);
  });
});

describe("scoreOf", () => {
  it("inverts lower-better metrics", () => {
    expect(scoreOf([higher("a", 5), lower("b", 2)])).toBe(3);
  });
});
