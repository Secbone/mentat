import { describe, expect, it } from "vitest";
import { knobArtifact } from "./demo";
import { defineEvalProtocol } from "./protocol";
import { buildReceipt } from "./receipt";
import type { Candidate, IterationRecord } from "./types";

const parent: Candidate = { id: "root", version: "root", artifacts: [knobArtifact(1)] };
const child: Candidate = {
  id: "c1",
  version: "v1",
  parentId: "root",
  artifacts: [knobArtifact(2)],
};
const protocol = defineEvalProtocol({
  id: "knob",
  version: 1,
  mode: "metric",
  dataset: { id: "fixture", revision: "1" },
});

const record: IterationRecord = {
  iteration: 1,
  parentId: "root",
  childId: "c1",
  proposal: { id: "c1", description: "raise knob", artifacts: child.artifacts },
  before: [{ name: "knob", value: 1, direction: "higher-better" }],
  after: [{ name: "knob", value: 2, direction: "higher-better" }],
  accepted: true,
  outcome: "completed",
};

describe("defineEvalProtocol", () => {
  it("content-addresses the protocol so changes cannot be confused", () => {
    const changed = defineEvalProtocol({ ...protocol, version: 2 });
    expect(changed.digest).not.toBe(protocol.digest);
    expect(protocol.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("buildReceipt", () => {
  it("binds the candidate digests, signals and protocol into one record", () => {
    const receipt = buildReceipt(record, {
      parent,
      child,
      protocol,
      environment: "test",
      at: "2026-10-22T00:00:00.000Z",
    });
    expect(receipt.parent.artifacts[0]?.digest).toBe(parent.artifacts[0]?.ref.digest);
    expect(receipt.candidate.artifacts[0]?.digest).toBe(child.artifacts[0]?.ref.digest);
    expect(receipt.protocol?.digest).toBe(protocol.digest);
    expect(receipt.signals.after?.[0]?.value).toBe(2);
    expect(receipt.outcome).toBe("completed");
    expect(receipt.accepted).toBe(true);
  });
});
