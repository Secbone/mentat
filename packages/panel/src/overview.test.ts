import { InMemoryRepositories } from "@mentat/domain";
import { describe, expect, it } from "vitest";
import { buildOverview, renderOverviewText } from "./overview";

function seed() {
  const repos = new InMemoryRepositories();
  repos.tickets.save({
    id: "t1",
    mandate: "m1",
    source: "local",
    threads: [],
    subscriptions: [],
    channels: [],
    inputs: [],
    assignments: ["a1"],
    openedAt: "2026-11-06T00:00:00.000Z",
    latestReport: "blocked",
    attention: { question: "which branch?", at: "2026-11-06T00:01:00.000Z" },
  });
  repos.assignments.save({
    id: "a1",
    ticket: "t1",
    worker: "fake",
    workspace: "/tmp",
    packDigest: "sha256:abc",
    state: "running",
  });
  repos.tickets.save({
    id: "t2",
    mandate: "m2",
    source: "local",
    threads: [],
    subscriptions: [],
    channels: [],
    inputs: [],
    assignments: [],
    openedAt: "2026-11-06T00:00:00.000Z",
    endedAt: "2026-11-06T00:02:00.000Z",
    outcome: "completed",
  });
  repos.decisions.save({
    id: "d1",
    eval: "e1",
    outcome: "accept",
    strength: "explicit",
    reasons: [],
    at: "2026-11-06T00:00:00.000Z",
  });
  return repos;
}

describe("panel overview", () => {
  it("puts person-blocked Tickets first and counts decisions", () => {
    const overview = buildOverview(seed(), {
      now: () => new Date("2026-11-06T00:00:00.000Z"),
    });
    expect(overview.counts).toMatchObject({ tickets: 2, open: 1, needsPerson: 1 });
    expect(overview.needsPerson[0]).toMatchObject({
      id: "t1",
      stage: "person/answer",
      question: "which branch?",
    });
    expect(overview.ended[0]).toMatchObject({ id: "t2", outcome: "completed" });
    expect(overview.decisions.accept).toBe(1);
    expect(overview.assignments[0]).toMatchObject({ worker: "fake", state: "running" });
    expect(overview.evolution).toEqual([]);
    expect(renderOverviewText(overview)).toContain("needs person: 1");

    const withSource = buildOverview(seed(), {
      source: {
        active: true,
        lastPollAt: "2026-11-06T00:00:00.000Z",
        lastPollCount: 3,
        consecutiveFailures: 0,
      },
    });
    expect(withSource.source).toMatchObject({ active: true, lastPollCount: 3 });
    expect(renderOverviewText(withSource)).toContain("source: active");

    const withChannel = buildOverview(seed(), {
      channel: {
        stable: { id: "worker", version: 2, digest: "sha256:stable" },
        canary: { id: "worker", version: 3, digest: "sha256:canary" },
        canaryRatio: 0.1,
      },
    });
    expect(withChannel.channel).toMatchObject({ canaryRatio: 0.1 });
    expect(renderOverviewText(withChannel)).toContain("pack: stable v2  canary v3 (10%)");
  });
});
