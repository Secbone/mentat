import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapabilityPack } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import { loadPackChannel } from "./pack-channel-store";

const pack = (version: number) =>
  defineCapabilityPack({
    id: "worker",
    version,
    prompt: { system: `v${version}`, role: "worker" },
  });

describe("pack channel persistence", () => {
  it("falls back to the initial pack and persists canary changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-channel-"));
    const path = join(dir, "pack-channel.json");
    const fallback = pack(1);
    const channel = loadPackChannel(path, fallback);
    expect(channel.current()).toBe(fallback);

    channel.setCanary(pack(2), 0.25);
    const reloaded = loadPackChannel(path, fallback);
    expect(reloaded.current()).toEqual(fallback);
    expect(reloaded.canary()?.version).toBe(2);
    expect(reloaded.ratio()).toBe(0.25);

    reloaded.promote();
    expect(loadPackChannel(path, fallback).current().version).toBe(2);
  });

  it("rejects a malformed snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-channel-"));
    const path = join(dir, "pack-channel.json");
    writeFileSync(path, "{}");
    expect(() => loadPackChannel(path, pack(1))).toThrow("invalid pack channel snapshot");
  });
});
