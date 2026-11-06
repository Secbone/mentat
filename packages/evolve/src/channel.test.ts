import { defineCapabilityPack } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import { PackChannel, type PackChannelSnapshot } from "./channel";

const pack = (version: number) =>
  defineCapabilityPack({
    id: "worker",
    version,
    prompt: { system: `v${version}`, role: "worker" },
  });

describe("PackChannel", () => {
  it("routes deterministically between stable and canary", () => {
    const stable = pack(1);
    const canary = pack(2);
    const channel = new PackChannel({
      stable,
      canary,
      canaryRatio: 0.5,
      bucket: (id) => (id === "canary" ? 0.1 : 0.9),
    });
    expect(channel.select("canary")).toEqual({ pack: canary, channel: "canary" });
    expect(channel.select("stable")).toEqual({ pack: stable, channel: "stable" });
    expect(channel.select("canary").channel).toBe("canary");
  });

  it("treats ratio 0 as stable-only and ratio 1 as canary-only", () => {
    const stable = pack(1);
    const canary = pack(2);
    expect(
      new PackChannel({ stable, canary, canaryRatio: 0, bucket: () => 0 }).select("x").channel,
    ).toBe("stable");
    expect(
      new PackChannel({ stable, canary, canaryRatio: 1, bucket: () => 0.999 }).select("x").channel,
    ).toBe("canary");
  });

  it("promotes the canary and rolls back to the previous stable", () => {
    const stable = pack(1);
    const canary = pack(2);
    const channel = new PackChannel({ stable, canary, canaryRatio: 1 });
    channel.promote();
    expect(channel.current()).toBe(canary);
    expect(channel.canary()).toBeUndefined();
    channel.rollback();
    expect(channel.current()).toBe(stable);
  });

  it("stops an active canary before reverting a promotion", () => {
    const stable = pack(1);
    const canary = pack(2);
    const channel = new PackChannel({ stable, canary, canaryRatio: 1 });
    channel.rollback();
    expect(channel.canary()).toBeUndefined();
    expect(channel.current()).toBe(stable);
    expect(() => channel.rollback()).toThrow("no previous pack");
  });

  it("emits snapshots after each mutation", () => {
    const snapshots: PackChannelSnapshot[] = [];
    const channel = new PackChannel({
      stable: pack(1),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    channel.setCanary(pack(2), 0.2);
    channel.promote();
    channel.rollback();
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({ canary: { version: 2 }, canaryRatio: 0.2 });
    expect(snapshots[1]).toMatchObject({ stable: { version: 2 }, canaryRatio: 0.2 });
    expect(snapshots[2]).toMatchObject({ stable: { version: 1 } });
  });

  it("rejects an invalid canary ratio", () => {
    expect(() => new PackChannel({ stable: pack(1), canaryRatio: 2 })).toThrow("between 0 and 1");
    expect(() => new PackChannel({ stable: pack(1), canaryRatio: -0.1 })).toThrow(
      "between 0 and 1",
    );
  });
});
