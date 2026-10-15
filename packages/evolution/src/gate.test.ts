import { describe, expect, it } from "vitest";
import { matchPath, pathGuardGate } from "./gate";
import type { Candidate } from "./types";

const candidate: Candidate = { id: "c", version: "c", artifacts: [] };

describe("matchPath", () => {
  it("matches directory globs", () => {
    expect(matchPath("packages/evolution/src/**", "packages/evolution/src/gate.ts")).toBe(true);
    expect(matchPath("packages/evolution/src/**", "packages/evolution/src")).toBe(true);
    expect(matchPath("packages/evolution/src/**", "packages/core/src/index.ts")).toBe(false);
  });

  it("matches extension globs and exact paths", () => {
    expect(matchPath("*.test.ts", "gate.test.ts")).toBe(true);
    expect(matchPath("*.test.ts", "src/gate.test.ts")).toBe(false);
    expect(matchPath("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchPath("src/a.ts", "src/b.ts")).toBe(false);
  });
});

describe("pathGuardGate", () => {
  it("rejects a change touching a protected path", async () => {
    const gate = pathGuardGate("protected", ["packages/evolution/src/**"], () => [
      "packages/evolution/src/gate.ts",
    ]);
    const result = await gate.check(candidate);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("protected path changed");
  });

  it("passes when no protected path changed", async () => {
    const gate = pathGuardGate("protected", ["packages/evolution/src/**"], () => [
      "packages/cli/src/index.ts",
    ]);
    expect((await gate.check(candidate)).passed).toBe(true);
  });
});
