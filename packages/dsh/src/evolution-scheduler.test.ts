import { describe, expect, it } from "vitest";
import { EvolutionScheduler, type EvolutionTarget } from "./evolution-scheduler";
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

describe("EvolutionScheduler", () => {
  it("runs one pass and records its observation count", async () => {
    const { scheduled, cleared, scheduler } = timers();
    const target: EvolutionTarget = {
      async evolve() {
        return {
          observations: [
            {
              id: "receipt:a1",
              at: "2026-11-06T00:00:00.000Z",
              text: "retry once",
              kind: "failure",
            },
          ],
        };
      },
    };
    const evolver = new EvolutionScheduler({
      evolver: target,
      intervalMs: 1000,
      scheduler,
      now: () => new Date("2026-11-06T00:00:00.000Z"),
    });
    evolver.start();
    expect(evolver.active).toBe(true);
    expect(scheduled).toHaveLength(1);
    await expect(evolver.tick()).resolves.toMatchObject({ observations: [{ id: "receipt:a1" }] });
    expect(evolver.health()).toMatchObject({
      active: true,
      lastObservations: 1,
      consecutiveFailures: 0,
    });
    evolver.stop();
    expect(evolver.active).toBe(false);
    expect(cleared).toEqual(["timer-1"]);
  });

  it("reports a failed pass without stopping the timer", async () => {
    const { scheduler } = timers();
    const errors: unknown[] = [];
    const evolver = new EvolutionScheduler({
      evolver: {
        async evolve() {
          throw new Error("offline");
        },
      },
      intervalMs: 1000,
      scheduler,
      onError: (error) => errors.push(error),
    });
    evolver.start();
    await expect(evolver.tick()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(evolver.health()).toMatchObject({
      active: true,
      lastError: "offline",
      consecutiveFailures: 1,
    });
    evolver.stop();
  });

  it("skips an overlapping tick while a pass is still running", async () => {
    let release: (() => void) | undefined;
    const evolver = new EvolutionScheduler({
      evolver: {
        async evolve() {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { observations: [] };
        },
      },
      intervalMs: 1000,
      scheduler: timers().scheduler,
    });
    const first = evolver.tick();
    await expect(evolver.tick()).resolves.toBeUndefined();
    release?.();
    await expect(first).resolves.toMatchObject({ observations: [] });
  });
});
