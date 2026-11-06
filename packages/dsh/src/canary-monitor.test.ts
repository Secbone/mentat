import { PackChannel } from "@mentat/evolve";
import { defineCapabilityPack, packRef } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import { CanaryMonitor } from "./canary-monitor";
import type { ReceiptStore, RuntimeReceipt } from "./runtime";

const pack = (version: number) =>
  defineCapabilityPack({
    id: "worker",
    version,
    prompt: { system: `v${version}`, role: "worker" },
  });

function receipt(
  assignment: string,
  channel: "stable" | "canary",
  kind: "ready" | "failed",
  at: string,
): RuntimeReceipt {
  const current = pack(1);
  return {
    version: 1,
    at,
    trigger: "trigger",
    ticket: "ticket",
    assignment,
    worker: "fake",
    packDigest: current.digest,
    pack: packRef(current),
    packChannel: channel,
    report: { kind, summary: kind },
    events: 0,
    outcome: kind === "ready" ? "completed" : "error",
  };
}

function store(rows: RuntimeReceipt[]): ReceiptStore {
  return {
    append() {},
    list: () => rows,
  };
}

function channel(): PackChannel {
  const stable = pack(1);
  const canary = pack(2);
  const channel = new PackChannel({
    stable,
    canary,
    canaryRatio: 0.1,
    now: () => new Date("2026-11-06T01:00:00.000Z"),
  });
  channel.setCanary(canary, 0.1);
  return channel;
}

const after = "2026-11-06T01:01:00.000Z";

describe("CanaryMonitor", () => {
  it("does nothing without a canary", () => {
    const stable = pack(1);
    const monitor = new CanaryMonitor({
      receipts: store([]),
      channel: new PackChannel({ stable }),
    });
    expect(monitor.assess()).toMatchObject({ rollback: false, reason: "no canary" });
  });

  it("waits for the minimum number of canary samples", () => {
    const rows = Array.from({ length: 4 }, (_, index) =>
      receipt(`c${index}`, "canary", "failed", after),
    );
    const monitor = new CanaryMonitor({
      receipts: store(rows),
      channel: channel(),
      policy: { minSamples: 5 },
    });
    expect(monitor.assess()).toMatchObject({
      rollback: false,
      reason: "canary samples 4/5",
    });
  });

  it("rolls back above the absolute failure ceiling", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      receipt(`c${index}`, "canary", "failed", after),
    );
    const monitor = new CanaryMonitor({
      receipts: store(rows),
      channel: channel(),
      policy: { minSamples: 5, maxFailureRate: 0.5 },
    });
    const assessment = monitor.assess();
    expect(assessment.rollback).toBe(true);
    expect(assessment.reason).toContain("canary failure rate 100%");
  });

  it("rolls back when canary regresses beyond the stable delta", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => receipt(`s${index}`, "stable", "ready", after)),
      ...Array.from({ length: 5 }, (_, index) =>
        receipt(`c${index}`, "canary", index < 2 ? "failed" : "ready", after),
      ),
    ];
    const monitor = new CanaryMonitor({
      receipts: store(rows),
      channel: channel(),
      policy: { minSamples: 5, maxFailureRate: 0.5, maxFailureRateDelta: 0.2 },
    });
    const assessment = monitor.assess();
    expect(assessment.rollback).toBe(true);
    expect(assessment.reason).toContain("exceeds stable 0%");
  });

  it("keeps a healthy canary", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => receipt(`s${index}`, "stable", "ready", after)),
      ...Array.from({ length: 5 }, (_, index) => receipt(`c${index}`, "canary", "ready", after)),
    ];
    const monitor = new CanaryMonitor({
      receipts: store(rows),
      channel: channel(),
      policy: { minSamples: 5 },
    });
    expect(monitor.assess()).toMatchObject({ rollback: false });
  });

  it("ignores canary receipts from before this canary started", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) =>
        receipt(`old${index}`, "canary", "failed", "2026-11-06T00:30:00.000Z"),
      ),
      receipt("new", "canary", "failed", after),
    ];
    const monitor = new CanaryMonitor({
      receipts: store(rows),
      channel: channel(),
      policy: { minSamples: 5 },
    });
    expect(monitor.assess()).toMatchObject({
      rollback: false,
      reason: "canary samples 1/5",
    });
  });

  it("enforce clears the canary on rollback", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      receipt(`c${index}`, "canary", "failed", after),
    );
    const target = channel();
    const monitor = new CanaryMonitor({
      receipts: store(rows),
      channel: target,
      policy: { minSamples: 5 },
    });
    expect(monitor.enforce()).toMatchObject({ rollback: true, rolledBack: true });
    expect(target.canary()).toBeUndefined();
  });
});
