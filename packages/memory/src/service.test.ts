import { describe, expect, it } from "vitest";
import { type MemoryAudit, type MemoryAuditRecord, MemoryService } from "./service";
import { InMemoryMemoryStore } from "./store";

function collector(): { records: MemoryAuditRecord[]; audit: MemoryAudit } {
  const records: MemoryAuditRecord[] = [];
  return { records, audit: { record: (r) => records.push(r) } };
}

describe("MemoryService", () => {
  it("retains resolved sources but drops stale source excerpts when the claim changes", () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);
    const request = {
      text: "leave five minutes",
      key: "buffer",
      evidence: "exp:old#msg0/part0",
      evidenceSources: [
        { pointer: "exp:old#msg0/part0", origin: "user", excerpt: "leave five minutes" },
      ],
    };
    expect(service.write(request).entry?.evidenceSources).toEqual(request.evidenceSources);
    expect(service.write(request).op).toBe("dedup");
    const updated = service.write({ text: "leave ten minutes", key: "buffer" });
    expect(updated.entry?.evidenceSources).toBeUndefined();
    expect(updated.previous?.evidenceSources).toEqual(request.evidenceSources);
  });
  it("rejects malformed source metadata without writing", () => {
    const store = new InMemoryMemoryStore();
    const result = new MemoryService(store).write({
      text: "x",
      evidenceSources: [{ pointer: "p", origin: "user", excerpt: "" }],
    });
    expect(result).toMatchObject({ op: "reject", reason: "invalid evidence sources" });
    expect(store.list()).toEqual([]);
  });
  it("rejects invalid kinds at the shared writer boundary", () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);
    expect(service.write({ text: "bad", kind: "invalid" as "fact" })).toMatchObject({
      op: "reject",
      reason: "invalid kind",
    });
    expect(store.list()).toEqual([]);
  });
  it("does not carry old evidence onto a different confirmed statement", () => {
    const store = new InMemoryMemoryStore();
    store.add({
      id: "rule",
      key: "deadline",
      text: "11点前回家",
      kind: "constraint",
      status: "active",
      basis: "user",
      evidence: "exp:old#msg0",
      evidenceIds: ["old"],
      createdAt: 1,
    });
    const result = new MemoryService(store).write({
      key: "deadline",
      text: "10点前回家",
      speaker: "user",
      basis: "user",
    });
    expect(result.entry?.evidence).toBeUndefined();
    expect(result.entry?.evidenceIds).toBeUndefined();
    expect(result.entry?.kind).toBe("constraint");
  });
  it("keeps unverified writes as candidates even if they request active status", () => {
    const service = new MemoryService(new InMemoryMemoryStore());
    for (const request of [
      { text: "unknown source" },
      { text: "assistant suggestion", speaker: "assistant", basis: "user", status: "active" },
      { text: "tool assertion", speaker: "tool", basis: "user", status: "active" },
    ] as const) {
      const result = service.write(request);
      expect(result.entry?.status).toBe("candidate");
      expect(result.entry?.basis).not.toBe("user");
    }
  });

  it("promotes a same-text candidate on explicit user confirmation and audits the transition", () => {
    const store = new InMemoryMemoryStore();
    const audit = collector();
    const service = new MemoryService(store, audit.audit);
    const candidate = service.write(
      {
        text: "周末11点前回家",
        key: "weekend-deadline",
        kind: "constraint",
        speaker: "assistant",
        basis: "inference",
        tags: ["constraint"],
      },
      1,
    );
    const confirmed = service.write(
      {
        text: "周末11点前回家",
        speaker: "user",
        basis: "user",
        evidence: "exp:manual#msg0",
      },
      2,
    );
    expect(confirmed.op).toBe("update");
    expect(confirmed.entry).toMatchObject({
      id: candidate.entry?.id,
      key: "weekend-deadline",
      kind: "constraint",
      status: "active",
      basis: "user",
      revision: 2,
      tags: ["constraint"],
      evidence: "exp:manual#msg0",
    });
    expect(audit.records.at(-1)?.previous?.status).toBe("candidate");
    expect(store.list()).toHaveLength(1);
    expect(service.write({ text: "周末11点前回家", speaker: "user", basis: "user" }).op).toBe(
      "dedup",
    );
  });

  it("does not let a model replace or downgrade an active rule", () => {
    const store = new InMemoryMemoryStore();
    const audit = collector();
    const service = new MemoryService(store, audit.audit);
    const confirmed = service.write({
      text: "不承诺退款",
      key: "refund",
      speaker: "user",
      basis: "user",
    });
    const proposal = {
      text: "默认全额退款",
      key: "refund",
      speaker: "assistant",
      basis: "inference",
    } as const;
    expect(service.write(proposal).op).toBe("reject");
    expect(store.list()).toEqual([confirmed.entry]);
    expect(audit.records.at(-1)?.request.text).toBe("默认全额退款");
    expect(service.write({ ...proposal, text: "不承诺退款" }).op).toBe("dedup");
    expect(store.list()).toEqual([confirmed.entry]);
    expect(service.write({ ...proposal, speaker: "user", basis: "user" }).op).toBe("update");
  });

  it("never resurrects inactive rules through an unverified write", () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);
    for (const status of ["expired", "archived", "superseded"] as const) {
      store.add({ id: status, key: status, text: "old rule", createdAt: 0, status });
      expect(service.write({ text: "new guess", key: status, speaker: "assistant" }).op).toBe(
        "reject",
      );
      expect(store.list().find((entry) => entry.id === status)?.status).toBe(status);
    }
  });

  it("keeps identical keys and text in different scopes separate", () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);
    for (const scope of ["user:a", "user:b"]) {
      service.write({ text: "先结论", key: "style", scope, speaker: "user", basis: "user" });
    }
    expect(store.list()).toHaveLength(2);
    expect(new Set(store.list().map((entry) => entry.id)).size).toBe(2);
    service.write({
      text: "先解释",
      key: "style",
      scope: "user:a",
      speaker: "user",
      basis: "user",
    });
    expect(store.list().find((entry) => entry.scope === "user:b")?.text).toBe("先结论");
  });

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
