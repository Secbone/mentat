import { describe, expect, it } from "vitest";
import { defaultAdmissionRow, gate, revalidate } from "./policy";
import type { Mandate, Policy, SourcePolicy, TriggerFacts } from "./types";

function source(overrides: Partial<SourcePolicy> = {}): SourcePolicy {
  return {
    allowed: ["alice"],
    bots: ["dependabot"],
    admission: defaultAdmissionRow(),
    ...overrides,
  };
}

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    acceptMode: "auto",
    rules: [{ id: "bug", name: "Bug", instruction: "Fix reported bugs", enabled: true }],
    sources: { github: source() },
    ...overrides,
  };
}

function facts(overrides: Partial<TriggerFacts> = {}): TriggerFacts {
  return {
    source: "github",
    sender: "alice",
    addressed: "mention",
    bot: false,
    followup: false,
    scope: "issue",
    ...overrides,
  };
}

function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: "m1",
    ticket: "t1",
    policyVersion: 1,
    strength: "explicit",
    scope: "issue",
    basis: { via: "addressed", source: "github", sender: "alice" },
    matchedRules: [],
    createdAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("gate", () => {
  it("admits an allowed person who addresses the agent", () => {
    expect(gate(policy(), facts())).toMatchObject({
      strength: "explicit",
      basis: { via: "addressed", sender: "alice" },
    });
  });

  it("ignores an unlisted person who addresses the agent by default", () => {
    expect(gate(policy(), facts({ sender: "mallory" })).strength).toBe("not_admitted");
  });

  it("honours an explicit admission cell", () => {
    const p = policy({
      sources: {
        github: source({
          admission: { ...defaultAdmissionRow(), unlistedAddressed: "explicit" },
        }),
      },
    });
    expect(gate(p, facts({ sender: "mallory" })).strength).toBe("explicit");
  });

  it("admits a listed person's unaddressed message as inferred", () => {
    expect(gate(policy(), facts({ addressed: "none" })).strength).toBe("inferred");
  });

  it("turns inferred work off in off mode", () => {
    expect(gate(policy({ acceptMode: "off" }), facts({ addressed: "none" })).strength).toBe(
      "not_admitted",
    );
  });

  it("treats a listed follow-up as explicit", () => {
    expect(gate(policy(), facts({ followup: true })).strength).toBe("explicit");
  });

  it("treats an unlisted follow-up as inferred, not explicit", () => {
    expect(gate(policy(), facts({ sender: "mallory", followup: true })).strength).toBe("inferred");
  });

  it("admits only listed bots, and only as inferred", () => {
    expect(
      gate(policy(), facts({ sender: "dependabot", bot: true, addressed: "none" })),
    ).toMatchObject({ strength: "inferred", basis: { via: "bot" } });
    expect(gate(policy(), facts({ sender: "evil[bot]", bot: true })).strength).toBe("not_admitted");
    expect(
      gate(policy({ acceptMode: "off" }), facts({ sender: "dependabot", bot: true })).strength,
    ).toBe("not_admitted");
  });

  it("does not admit a source with no Policy", () => {
    expect(gate(policy(), facts({ source: "unknown" })).strength).toBe("not_admitted");
  });
});

describe("revalidate", () => {
  it("lets an explicit follow-up resume while the source listens", () => {
    expect(
      revalidate(
        policy(),
        mandate({ basis: { via: "followup", source: "github", sender: "alice" } }),
        facts(),
        { sourceListens: true },
      ),
    ).toBe(true);
  });

  it("refuses when the source stopped listening or the mandate was withdrawn", () => {
    expect(revalidate(policy(), mandate(), facts(), { sourceListens: false })).toBe(false);
    expect(
      revalidate(policy(), mandate({ withdrawnAt: "2026-11-05T00:00:00.000Z" }), facts(), {
        sourceListens: true,
      }),
    ).toBe(false);
  });

  it("requires auto mode and enabled rules for inferred mandates", () => {
    const inferred = mandate({
      strength: "inferred",
      matchedRules: ["bug"],
      basis: { via: "admission", source: "github", sender: "alice" },
    });
    expect(
      revalidate(policy(), inferred, facts({ addressed: "none" }), { sourceListens: true }),
    ).toBe(true);
    expect(
      revalidate(policy({ acceptMode: "observe" }), inferred, facts({ addressed: "none" }), {
        sourceListens: true,
      }),
    ).toBe(false);
    expect(
      revalidate(
        policy({ rules: [{ id: "bug", name: "Bug", instruction: "x", enabled: false }] }),
        inferred,
        facts({ addressed: "none" }),
        { sourceListens: true },
      ),
    ).toBe(false);
  });

  it("requires the sender to remain allowed for explicit mandates", () => {
    const p = policy({ sources: { github: source({ allowed: [] }) } });
    expect(revalidate(p, mandate(), facts(), { sourceListens: true })).toBe(false);
  });

  it("requires a bot to remain listed for bot mandates", () => {
    const bot = mandate({
      strength: "inferred",
      matchedRules: ["bug"],
      basis: { via: "bot", source: "github", sender: "dependabot" },
    });
    expect(
      revalidate(policy(), bot, facts({ sender: "dependabot", bot: true }), {
        sourceListens: true,
      }),
    ).toBe(true);
    const p = policy({ sources: { github: source({ bots: [] }) } });
    expect(
      revalidate(p, bot, facts({ sender: "dependabot", bot: true }), { sourceListens: true }),
    ).toBe(false);
  });
});
