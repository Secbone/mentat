import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceKind, Trigger } from "@mentat/domain";
import { describe, expect, it } from "vitest";
import { type PollScheduler, SourcePoller } from "./poller";
import { createMentatService } from "./service";

function trigger(): Trigger {
  return {
    id: "s1",
    source: "fake",
    thread: "thread-s",
    actor: "local-user",
    bot: false,
    addressed: "mention",
    text: "from source",
    at: "2026-11-06T00:00:00.000Z",
    meta: { scope: "local" },
  };
}

function source(): SourceKind {
  return {
    id: "fake",
    label: "Fake",
    async poll() {
      return [trigger()];
    },
  };
}

describe("SourcePoller", () => {
  it("polls a Source into the runtime", async () => {
    const service = createMentatService({
      dir: mkdtempSync(join(tmpdir(), "mentat-poller-")),
      source: source(),
    });
    expect(service.poller).toBeDefined();
    expect(await service.poller?.tick()).toBe(1);
    expect(service.repos.triggers.list()).toHaveLength(1);
    expect(service.poller?.health()).toMatchObject({
      lastPollCount: 1,
      consecutiveFailures: 0,
    });
    await service.runtime.dispose();
  });

  it("starts and stops its timer and reports poll errors", async () => {
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    const scheduler: PollScheduler = {
      set(action) {
        scheduled.push(action);
        return "timer-1";
      },
      clear(handle) {
        cleared.push(handle);
      },
    };
    const errors: unknown[] = [];
    const poller = new SourcePoller({
      source: {
        id: "bad",
        label: "Bad",
        async poll() {
          throw new Error("offline");
        },
      },
      runtime: {
        async pollSource() {
          throw new Error("offline");
        },
      },
      intervalMs: 1000,
      scheduler,
      onError: (error) => errors.push(error),
    });
    poller.start();
    expect(poller.active).toBe(true);
    expect(scheduled).toHaveLength(1);
    await poller.tick();
    expect(errors).toHaveLength(1);
    expect(poller.health()).toMatchObject({
      active: true,
      lastError: "offline",
      consecutiveFailures: 1,
    });
    poller.stop();
    expect(poller.active).toBe(false);
    expect(cleared).toEqual(["timer-1"]);
  });
});
