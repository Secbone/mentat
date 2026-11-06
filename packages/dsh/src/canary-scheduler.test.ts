import { describe, expect, it } from "vitest";
import type { CanaryAssessment } from "./canary-monitor";
import { CanaryScheduler, type CanaryTarget } from "./canary-scheduler";
import type { TimerScheduler } from "./scheduler";

function timers() {
  const scheduled: Array<() => void> = [];
  const cleared: unknown[] = [];
  const scheduler: TimerScheduler = {
    set(action) {
      scheduled.push(action);
      return "timer-1";
    },
    clear(handle) {
      cleared.push(handle);
    },
  };
  return { scheduled, cleared, scheduler };
}

const healthy: CanaryAssessment & { rolledBack: boolean } = {
  rollback: false,
  rolledBack: false,
  canary: { total: 5, completed: 5, failed: 0, failureRate: 0 },
  stable: { total: 5, completed: 5, failed: 0, failureRate: 0 },
};

describe("CanaryScheduler", () => {
  it("runs a check and records its result", async () => {
    const { scheduled, cleared, scheduler } = timers();
    const target: CanaryTarget = { enforce: () => healthy };
    const canary = new CanaryScheduler({
      monitor: target,
      intervalMs: 1000,
      scheduler,
      now: () => new Date("2026-11-06T00:00:00.000Z"),
    });
    canary.start();
    expect(scheduled).toHaveLength(1);
    await expect(canary.tick()).resolves.toMatchObject({ rolledBack: false });
    expect(canary.health()).toMatchObject({ active: true, lastRollback: false });
    canary.stop();
    expect(cleared).toEqual(["timer-1"]);
  });

  it("reports a rollback", async () => {
    const rolledBack: Array<CanaryAssessment & { rolledBack: true }> = [];
    const canary = new CanaryScheduler({
      monitor: {
        enforce: () => ({
          ...healthy,
          rollback: true,
          rolledBack: true,
          reason: "regression",
        }),
      },
      intervalMs: 1000,
      scheduler: timers().scheduler,
      onRollback: (assessment) => rolledBack.push(assessment),
    });
    await canary.tick();
    expect(rolledBack).toHaveLength(1);
    expect(canary.health()).toMatchObject({ lastRollback: true, lastReason: "regression" });
  });

  it("reports a failed check without stopping the timer", async () => {
    const errors: unknown[] = [];
    const canary = new CanaryScheduler({
      monitor: {
        enforce() {
          throw new Error("offline");
        },
      },
      intervalMs: 1000,
      scheduler: timers().scheduler,
      onError: (error) => errors.push(error),
    });
    canary.start();
    await expect(canary.tick()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(canary.health()).toMatchObject({
      active: true,
      lastError: "offline",
      consecutiveFailures: 1,
    });
    canary.stop();
  });
});
