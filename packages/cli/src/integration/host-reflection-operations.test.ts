import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import { createMemoryAccess } from "@mentat/memory";
import { FileMemoryRepository } from "@mentat/memory-file";
import { expect, it } from "vitest";

it("applies scoped proposals, merges new evidence and exposes rejections without altering active rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-reflection-ops-"));
  let mode: "add" | "merge" | "task" = "add";
  const adapter = createFakeAdapter({
    script: (input) => {
      const batch = JSON.parse(input.text.match(/Evidence batch: (.*)\n/)?.[1] ?? "{}");
      const merge = mode === "merge";
      return [
        JSON.stringify({
          batchId: batch.batchId,
          candidates: [
            {
              text: merge ? "排期先表格后核对" : "先给时间表，再核对约束",
              kind: "preference",
              operation: merge ? "merge" : "add",
              ...(merge ? { targetRef: batch.memories[0]?.ref ?? "C1" } : {}),
              evidenceRefs:
                mode === "task"
                  ? [{ ref: "E1.M1.P1", excerpt: "这次先问时间约束" }]
                  : [
                      { ref: "E1.M1.P1", excerpt: "先给时间表，再核对约束" },
                      ...(merge ? [{ ref: "E2.M1.P1", excerpt: "先给时间表，再核对约束" }] : []),
                    ],
            },
          ],
        }),
      ];
    },
  });
  const host = createAssistantHost({
    cwd: dir,
    adapter: createFakeAdapter(),
    reflectionAdapter: adapter,
    memoryPath: join(dir, "memory.json"),
  });
  try {
    const session = await host.open();
    const first = (
      await host.turn(session, { text: "先给时间表，再核对约束", memoryScope: "reusable" })
    ).record;
    const base = { task: "schedule", outcome: "done", tools: [] };
    expect(await host.reflect({ ...base, interactions: [first] })).toMatchObject({
      added: 1,
      merged: 0,
      applicationStatus: "complete",
    });
    const second = (
      await host.turn(session, { text: "先给时间表，再核对约束", memoryScope: "reusable" })
    ).record;
    mode = "merge";
    const merged = await host.reflect({ ...base, interactions: [first, second] });
    expect(merged).toMatchObject({ added: 0, merged: 1, rejected: 0 });
    let entries = await host.memory.search({});
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      text: "先给时间表，再核对约束",
      revision: 2,
      applicability: "reusable",
      status: "candidate",
    });
    expect(entries[0]?.evidenceSources).toHaveLength(2);
    expect(await host.reflect({ ...base, interactions: [first, second] })).toMatchObject({
      added: 0,
      merged: 0,
      rejected: 0,
    });
    mode = "task";
    const local = (await host.turn(session, { text: "这次先问时间约束", memoryScope: "task" }))
      .record;
    expect(await host.reflect({ ...base, interactions: [local] })).toMatchObject({
      skipped: 1,
      added: 0,
    });
    await host.remember({ text: "先给时间表，再核对约束", kind: "preference" });
    mode = "merge";
    expect(await host.reflect({ ...base, interactions: [first, second] })).toMatchObject({
      rejected: 1,
      applicationStatus: "rejected",
      decisions: [{ reason: "merge cannot modify an established rule" }],
    });
    entries = await host.memory.search({});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("active");
  } finally {
    await host.close();
  }
});

it("version-checks competing file writers inside the durable transaction", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-evidence-cas-")), "memory.json");
  const first = createMemoryAccess(new FileMemoryRepository(path)),
    second = createMemoryAccess(new FileMemoryRepository(path));
  const source = {
    pointer: "exp:a#msg0",
    origin: "user",
    excerpt: "长期保留5分钟",
    memoryScope: "reusable" as const,
  };
  const initial = await first.propose({
    text: "保留5分钟",
    kind: "constraint",
    applicability: "reusable",
    evidenceIds: ["a"],
    evidenceSources: [source],
  });
  const targetId = initial.entry?.id;
  if (!targetId) throw Error("missing candidate");
  const results = await Promise.all(
    [first, second].map((access, index) =>
      access.propose({
        mode: "merge-evidence",
        targetId,
        expectedEntryRevision: 1,
        text: "预留5分钟余量",
        kind: "constraint",
        applicability: "reusable",
        evidenceIds: ["a", `extra-${index}`],
        evidenceSources: [source, { ...source, pointer: `exp:extra-${index}#msg0` }],
      }),
    ),
  );
  expect(results.map((result) => result.op).sort()).toEqual(["reject", "update"]);
  const entries = await first.search({});
  expect(entries[0]?.revision).toBe(2);
  expect(entries[0]?.evidenceSources).toHaveLength(2);
  expect(entries[0]?.text).toBe("保留5分钟");
});
