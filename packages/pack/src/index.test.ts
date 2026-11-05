import { describe, expect, it } from "vitest";
import { defineCapabilityPack, packRef } from "./index";

function pack(overrides: Partial<Parameters<typeof defineCapabilityPack>[0]> = {}) {
  return defineCapabilityPack({
    id: "worker-default",
    version: 1,
    prompt: { system: "do the work", role: "worker" },
    model: { model: "test/model" },
    ...overrides,
  });
}

describe("CapabilityPack", () => {
  it("content-addresses the pack deterministically", () => {
    const a = pack();
    const b = pack();
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("changes the digest when prompt, version, model or skills change", () => {
    const base = pack();
    expect(pack({ version: 2 }).digest).not.toBe(base.digest);
    expect(pack({ prompt: { system: "different", role: "worker" } }).digest).not.toBe(base.digest);
    expect(pack({ model: { model: "other/model" } }).digest).not.toBe(base.digest);
    expect(pack({ skills: [{ name: "debug", version: 1 }] }).digest).not.toBe(base.digest);
  });

  it("exposes a stable reference for Assignments and receipts", () => {
    const value = pack();
    expect(packRef(value)).toEqual({
      id: value.id,
      version: value.version,
      digest: value.digest,
    });
  });
});
