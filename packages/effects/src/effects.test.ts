import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Outbox } from "./outbox";
import { EffectQueue, Later } from "./queue";

function queue() {
  let now = new Date("2026-11-05T00:00:00.000Z");
  let id = 0;
  const q = new EffectQueue({
    path: join(mkdtempSync(join(tmpdir(), "mentat-effects-")), "effects.json"),
    now: () => now,
    id: () => `e${++id}`,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  });
  return {
    q,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("EffectQueue", () => {
  it("coalesces waiting effects by kind and key", () => {
    const { q } = queue();
    const first = q.enqueue("launch", "assignment-1", { value: 1 });
    const second = q.enqueue("launch", "assignment-1", { value: 2 });
    expect(second.id).toBe(first.id);
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0]?.payload).toEqual({ value: 2 });
  });

  it("runs a due effect and records success", async () => {
    const { q } = queue();
    const seen: unknown[] = [];
    q.handle("launch", async (payload) => {
      seen.push(payload);
    });
    q.enqueue("launch", "a1", { assignment: "a1" });
    expect(await q.runDue()).toBe(1);
    expect(seen).toEqual([{ assignment: "a1" }]);
    expect(q.pending()).toHaveLength(0);
    expect(q.list()[0]?.status).toBe("done");
  });

  it("retries with backoff and then fails", async () => {
    const { q, advance } = queue();
    q.handle("launch", async () => {
      throw new Error("boom");
    });
    q.enqueue("launch", "a1", {});
    await q.runDue();
    expect(q.list()[0]).toMatchObject({ status: "waiting", attempts: 1 });
    advance(100);
    await q.runDue();
    expect(q.list()[0]).toMatchObject({ status: "waiting", attempts: 2 });
    advance(200);
    await q.runDue();
    expect(q.list()[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(q.health().launch?.consecutiveFailures).toBe(3);
  });

  it("defers a Later without counting a failure", async () => {
    const { q, advance } = queue();
    q.handle("launch", async () => {
      throw new Later("not yet");
    });
    q.enqueue("launch", "a1", {});
    await q.runDue();
    expect(q.list()[0]).toMatchObject({ status: "waiting", attempts: 0 });
    expect(q.health().launch).toBeUndefined();
    advance(100);
    await q.runDue();
    expect(q.list()[0]?.status).toBe("waiting");
  });

  it("persists records across instances", async () => {
    const { q } = queue();
    q.enqueue("launch", "a1", { assignment: "a1" });
    const reloaded = new EffectQueue({ path: q.path });
    expect(reloaded.pending()).toHaveLength(1);
    expect(reloaded.pending()[0]?.key).toBe("a1");
  });
});

describe("Outbox", () => {
  it("sends through the transport and settles the receipt", async () => {
    const { q } = queue();
    const sent: unknown[] = [];
    const outbox = new Outbox(
      q,
      {
        async send(message) {
          sent.push(message);
          return "sent";
        },
      },
      { path: join(mkdtempSync(join(tmpdir(), "mentat-outbox-")), "outbox.json") },
    );
    const receipt = outbox.send({
      ticket: "t1",
      channel: "github:1",
      purpose: "answer",
      text: "done",
    });
    expect(receipt.status).toBe("waiting");
    await q.runDue();
    expect(sent).toHaveLength(1);
    expect(outbox.receipts()[0]?.status).toBe("sent");
  });

  it("marks a gone conversation dropped instead of retrying forever", async () => {
    const { q } = queue();
    const outbox = new Outbox(
      q,
      {
        async send() {
          return "gone";
        },
      },
      { path: join(mkdtempSync(join(tmpdir(), "mentat-outbox-")), "outbox.json") },
    );
    outbox.send({ channel: "github:gone", purpose: "result", text: "x" });
    await q.runDue();
    expect(outbox.receipts()[0]?.status).toBe("dropped");
    expect(q.pending()).toHaveLength(0);
  });
});
