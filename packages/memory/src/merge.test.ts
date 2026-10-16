import { expect, it } from "vitest";
import { buildTurnContext } from "./context";
import { MemoryService } from "./service";
import { InMemoryMemoryStore } from "./store";

function setup() {
  const store = new InMemoryMemoryStore(),
    service = new MemoryService(store);
  const source = {
    pointer: "exp:a#msg0/part0",
    origin: "user",
    excerpt: "长期留5分钟缓冲",
    memoryScope: "reusable" as const,
  };
  const target = service.write(
    {
      text: "留5分钟缓冲",
      kind: "constraint",
      basis: "inference",
      speaker: "assistant",
      applicability: "reusable",
      evidenceIds: ["a"],
      evidenceSources: [source],
    },
    1,
  ).entry;
  if (!target) throw Error("missing candidate");
  const request = {
    mode: "merge-evidence" as const,
    text: "预留5分钟余量",
    kind: "constraint" as const,
    targetId: target.id,
    expectedEntryRevision: 1,
    applicability: "reusable" as const,
    evidenceIds: ["a", "b"],
    evidenceSources: [source, { ...source, pointer: "exp:b#msg0/part0" }],
  };
  return { store, service, target, request, source };
}

it("merges evidence atomically while preserving canonical claim, identity, kind and status", () => {
  const { service, target, request } = setup();
  const merged = service.write(request, 2);
  expect(merged).toMatchObject({
    op: "update",
    previous: { revision: 1 },
    entry: {
      id: target.id,
      key: target.key,
      text: target.text,
      kind: "constraint",
      status: "candidate",
      revision: 2,
      evidenceIds: ["a", "b"],
      evidenceSources: expect.any(Array),
    },
  });
  expect(merged.entry?.evidenceSources).toHaveLength(2);
  expect(service.write(request, 3).op).toBe("dedup");
  expect(service.list()).toHaveLength(1);
  expect(service.list()[0]?.revision).toBe(2);
});

it("rejects a stale merge that carries new evidence without losing the first writer's evidence", () => {
  const { service, request, source } = setup();
  service.write(request, 2);
  const result = service.write(
    {
      ...request,
      evidenceIds: ["a", "c"],
      evidenceSources: [source, { ...source, pointer: "exp:c#msg0" }],
    },
    3,
  );
  expect(result).toMatchObject({ op: "reject", reason: "merge target revision changed" });
  expect(service.list()[0]?.evidenceIds).toEqual(["a", "b"]);
});

it("does not merge established rules, other audiences, kinds or reuse scopes", () => {
  const { service, store, target, request } = setup();
  for (const change of [
    { kind: "preference" as const },
    { scope: "other-user" },
    { condition: "management" },
    { applicability: "unresolved" as const },
  ])
    expect(service.write({ ...request, ...change }).op).toBe("reject");
  store.add({ ...target, status: "active" });
  expect(service.write(request)).toMatchObject({
    op: "reject",
    reason: "merge cannot modify an established rule",
  });
  expect(service.list()[0]).toMatchObject({ status: "active", text: target.text, revision: 1 });
});

it("rejects changed numbers or paraphrases without a shared source excerpt", () => {
  const { service, request, source } = setup();
  expect(service.write({ ...request, text: "留10分钟缓冲" }).op).toBe("reject");
  expect(
    service.write({ ...request, evidenceSources: [{ ...source, pointer: "exp:unrelated#msg0" }] })
      .op,
  ).toBe("reject");
  expect(service.list()[0]?.revision).toBe(1);
});

it("keeps repeated evidence and metadata rather than replacing them on same-text adds", () => {
  const { service, target, source } = setup();
  expect(
    service.write({
      text: target.text,
      kind: target.kind,
      applicability: "reusable",
      evidenceIds: ["b"],
      evidenceSources: [{ ...source, pointer: "exp:b#msg0" }],
    }).op,
  ).toBe("update");
  expect(service.list()[0]?.evidenceIds).toEqual(["a", "b"]);
  expect(service.list()[0]?.evidenceSources).toHaveLength(2);
});

it("cannot turn task-local evidence into reusable memory or leak task entries into long-term context", () => {
  const { service, store, source } = setup();
  expect(
    service.write({
      text: "always ask",
      applicability: "reusable",
      evidenceSources: [{ ...source, memoryScope: "task" }],
    }),
  ).toMatchObject({ op: "reject" });
  store.add({
    id: "temporary",
    text: "this task only",
    applicability: "task",
    kind: "constraint",
    status: "active",
    createdAt: 2,
  });
  expect(buildTurnContext(store, "this task").selectedIds).not.toContain("temporary");
});
