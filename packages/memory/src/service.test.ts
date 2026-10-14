import { describe, expect, it } from "vitest";
import { type MemoryAudit, type MemoryAuditRecord, MemoryService } from "./service";
import { InMemoryMemoryStore } from "./store";

function collector(): { records: MemoryAuditRecord[]; audit: MemoryAudit } {
  const records: MemoryAuditRecord[] = [];
  return { records, audit: { record: (r) => records.push(r) } };
}

describe("MemoryService", () => {
  it("adds, then dedups identical text", () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    expect(service.write({ text: "the build takes 3 minutes" }).op).toBe("add");
    expect(store.list()).toHaveLength(1);
    expect(service.write({ text: "the build takes 3 minutes" }).op).toBe("dedup");
    expect(store.list()).toHaveLength(1);
  });

  it("updates in place on a stable key (keeps the previous version in the audit)", () => {
    const audit = collector();
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, audit.audit);

    service.write({ text: "build takes 3 minutes", key: "build-time" });
    const updated = service.write({ text: "build takes 2 minutes", key: "build-time" });

    expect(updated.op).toBe("update");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.text).toBe("build takes 2 minutes");
    expect(store.list()[0]?.revision).toBe(2);

    const updateRecord = audit.records.find((r) => r.op === "update");
    expect(updateRecord?.previous?.text).toBe("build takes 3 minutes");
  });

  it("rejects an assistant claiming a fact came from the user (downgrades to candidate/inference)", () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    const result = service.write({
      text: "user prefers full refunds",
      kind: "preference",
      basis: "user",
      speaker: "assistant",
    });

    expect(result.op).toBe("add");
    expect(result.entry?.basis).toBe("inference");
    expect(result.entry?.status).toBe("candidate");
  });

  it("rejects empty text and records the reason", () => {
    const audit = collector();
    const service = new MemoryService(new InMemoryMemoryStore(), audit.audit);
    const result = service.write({ text: "   " });
    expect(result.op).toBe("reject");
    expect(result.reason).toBe("empty text");
    expect(audit.records.at(-1)?.reason).toBe("empty text");
  });
});
