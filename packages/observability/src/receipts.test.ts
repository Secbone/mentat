import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IterationReceipt } from "@mentat/evolution";
import { describe, expect, it } from "vitest";
import { ReceiptStore } from "./receipts";

const receipt: IterationReceipt = {
  version: 1,
  iteration: 1,
  at: "2026-10-22T00:00:00.000Z",
  outcome: "completed",
  accepted: true,
  parent: { id: "root", version: "root", artifacts: [] },
  candidate: { id: "c1", version: "v1", artifacts: [] },
  signals: {
    before: [{ name: "recall", value: 0.5, direction: "higher-better" }],
    after: [{ name: "recall", value: 1, direction: "higher-better" }],
  },
};

describe("ReceiptStore", () => {
  it("appends and reads receipts in order", () => {
    const store = new ReceiptStore(mkdtempSync(join(tmpdir(), "mentat-receipts-")));
    store.append(receipt);
    store.append({ ...receipt, iteration: 2, accepted: false, outcome: "invalid" });
    expect(store.read().map((item) => item.iteration)).toEqual([1, 2]);
    expect(store.read()[1]?.outcome).toBe("invalid");
  });

  it("reports the line of a corrupt receipt instead of silently skipping it", () => {
    const store = new ReceiptStore(mkdtempSync(join(tmpdir(), "mentat-receipts-")));
    store.append(receipt);
    appendFileSync(store.path, "not json\n");
    expect(() => store.read()).toThrow("corrupt receipt");
  });
});
