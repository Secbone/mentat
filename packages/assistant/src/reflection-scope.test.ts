import { createMemoryAccess, InMemoryMemoryStore, MemoryService } from "@mentat/memory";
import { SessionRecorder } from "@mentat/session";
import { expect, it } from "vitest";
import { applyReflections } from "./reflect";
import { parseEvidenceReflection } from "./reflection";
import { buildReflectionBatch } from "./reflection-evidence";

function record(memoryScope?: "task" | "reusable") {
  return new SessionRecorder({
    prompt: "先问不能违反的时间约束",
    input: { text: "先问不能违反的时间约束", ...(memoryScope ? { memoryScope } : {}) },
    cwd: "/tmp",
    harness: "test",
  }).snapshot();
}
function parse(batch: ReturnType<typeof buildReflectionBatch>, extra = {}) {
  return parseEvidenceReflection(
    JSON.stringify({
      batchId: batch.id,
      candidates: [
        {
          text: "总是先询问时间约束",
          kind: "preference",
          evidenceRefs: [{ ref: "E1.M1.P1", excerpt: "先问不能违反的时间约束" }],
          applicability: "reusable",
          ...extra,
        },
      ],
    }),
    batch,
  );
}
function memory() {
  const store = new InMemoryMemoryStore(),
    service = new MemoryService(store);
  return {
    store,
    access: createMemoryAccess({
      async snapshot() {
        return { revision: "0", entries: store.list() };
      },
      async commit(request) {
        return service.write(request);
      },
    }),
  };
}

it("host scope narrows model generalization, and task proposals stay out of long-term memory", async () => {
  const { store, access } = memory();
  const parsed = parse(buildReflectionBatch([record("task")]));
  expect(parsed.candidates[0]?.applicability).toBe("task");
  expect(await applyReflections(access, parsed.candidates)).toMatchObject({ added: 0, skipped: 1 });
  expect(store.list()).toEqual([]);
});

it("unspecified evidence remains unresolved while explicit reuse intent remains candidate only", async () => {
  const { store, access } = memory();
  const unresolved = parse(buildReflectionBatch([record()]));
  expect(unresolved.candidates[0]?.applicability).toBe("unresolved");
  await applyReflections(access, unresolved.candidates);
  expect(store.list()[0]).toMatchObject({ applicability: "unresolved", status: "candidate" });
  const reusable = parse(buildReflectionBatch([record("reusable")]));
  expect(reusable.candidates[0]?.applicability).toBe("reusable");
  // An unreviewed add cannot silently widen an existing unresolved candidate.
  expect(await applyReflections(access, reusable.candidates)).toMatchObject({ rejected: 1 });
  expect(store.list()[0]).toMatchObject({ applicability: "unresolved", status: "candidate" });
});

it("uses current memory aliases to merge repeated paraphrases without replacing their canonical text", async () => {
  const { store, access } = memory(),
    interaction = record("reusable");
  const first = parse(buildReflectionBatch([interaction]));
  await applyReflections(access, first.candidates);
  const target = store.list()[0];
  const next = parse(buildReflectionBatch([interaction], store.list()), {
    operation: "merge",
    targetRef: "C1",
    text: "排期时先问时间约束",
  });
  expect(await applyReflections(access, next.candidates)).toMatchObject({ added: 0, rejected: 0 });
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0]?.text).toBe(target?.text);
});

it("retains separate candidates for different audiences instead of treating equal text as equal scope", async () => {
  const { store, access } = memory();
  const batch = buildReflectionBatch([record("reusable")]);
  const management = parse(batch, { condition: "management brief" });
  const detail = parse(batch, { condition: "detail audit" });
  expect(await applyReflections(access, management.candidates)).toMatchObject({ added: 1 });
  expect(await applyReflections(access, detail.candidates)).toMatchObject({ added: 1 });
  expect(store.list()).toHaveLength(2);
  const next = parse(buildReflectionBatch([record("reusable")], store.list()), {
    operation: "merge",
    targetRef: "C1",
    condition: "detail audit",
  });
  expect(await applyReflections(access, next.candidates)).toMatchObject({ rejected: 1 });
  expect(store.list().map((entry) => entry.revision)).toEqual([1, 1]);
});
