import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { createAssistantHost, rememberUserFact } from "@mentat/host";
import {
  buildTurnContext,
  InMemoryMemoryStore,
  type MemoryEntry,
  MemoryService,
} from "@mentat/memory";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { ExperienceStore } from "@mentat/observability";
import { expect, it } from "vitest";

it("confirms a persisted candidate with evidence of the actual manual directive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-confirm-"));
  const path = join(dir, "memory.json");
  const experience = join(dir, "experience");
  new MemoryService(new JsonFileMemoryStore(path)).write({
    key: "weekend",
    text: "周末11点前回家",
    kind: "constraint",
    basis: "inference",
    speaker: "assistant",
  });
  expect(buildTurnContext(new JsonFileMemoryStore(path), "周末").text).toBe("");
  const result = await rememberUserFact(path, experience, "周末11点前回家");
  expect(result).toMatchObject({
    op: "update",
    entry: { key: "weekend", kind: "constraint", status: "active", revision: 2 },
  });
  const records = new ExperienceStore(experience).list();
  expect(records).toHaveLength(1);
  expect(records[0]?.messages?.[0]).toMatchObject({ role: "user", text: "周末11点前回家" });
  expect(result.entry?.evidence).toBe(`exp:${records[0]?.id}#msg0`);
  expect(buildTurnContext(new JsonFileMemoryStore(path), "周末").text).toContain("周末11点前回家");
  expect(
    JSON.parse(readFileSync(`${path}.audit.jsonl`, "utf8").trim().split("\n").at(-1) ?? "").previous
      .status,
  ).toBe("candidate");
});

it("preserves explicitly typed rules through host, repository, budget selection and reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-typed-confirm-"));
  const path = join(dir, "memory.json");
  const host = createAssistantHost({
    cwd: dir,
    adapter: createFakeAdapter(),
    memoryPath: path,
    scope: "personal",
  });
  try {
    const constraint = await host.remember({
      text: "周末必须严格11点前回家，额外留5分钟余量",
      kind: "constraint",
      key: "weekend-deadline",
      condition: "周末外出",
    });
    expect(constraint).toMatchObject({
      classification: "explicit",
      entry: {
        kind: "constraint",
        scope: "personal",
        condition: "周末外出",
        key: "weekend-deadline",
        status: "active",
      },
    });
    const preference = await host.remember({ text: "先给时间表", kind: "preference" });
    expect(preference.entry?.kind).toBe("preference");
    const noise: MemoryEntry = {
      id: "newer-noise",
      text: "",
      kind: "fact",
      status: "active",
      scope: "personal",
      createdAt: Date.now() + 10000,
    };
    const view = new InMemoryMemoryStore();
    view.add(noise);
    noise.text = "x".repeat(6000 - buildTurnContext(view, "unrelated").text.length);
    new JsonFileMemoryStore(path).add(noise);
    const context = await host.memory.context("unrelated");
    expect(context.requiredIds).toContain(constraint.entry?.id);
    expect(context.selectedIds).toContain(constraint.entry?.id);
    expect(context.requiredIds).not.toContain(preference.entry?.id);
    expect(context.omittedIds).toContain("newer-noise");
    expect(
      new JsonFileMemoryStore(path).list().find((entry) => entry.id === constraint.entry?.id)?.kind,
    ).toBe("constraint");
    const proposal = await host.memory.propose({
      text: "inferred constraint",
      kind: "constraint",
      basis: "user",
      speaker: "user",
    });
    expect(proposal.entry?.status).toBe("candidate");
    expect((await host.memory.context("inferred constraint")).requiredIds).not.toContain(
      proposal.entry?.id,
    );
  } finally {
    await host.close();
  }
});

it("blocks oversized constraints written through the real confirmation entrypoint before send", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-typed-overflow-"));
  const host = createAssistantHost({
    cwd: dir,
    adapter: createFakeAdapter(),
    memoryPath: join(dir, "memory.json"),
  });
  try {
    await host.remember({ text: "必须保留".repeat(2000), kind: "constraint" });
    const session = await host.open();
    let starts = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "run.started") starts++;
    });
    await expect(host.turn(session, "出门安排")).rejects.toThrow("required constraints");
    unsubscribe();
    expect(starts).toBe(0);
  } finally {
    await host.close();
  }
});

it("reports unspecified classification and does not trust caller-supplied source fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-confirm-source-"));
  const diagnostics: string[] = [];
  const host = createAssistantHost(
    { cwd: dir, adapter: createFakeAdapter(), memoryPath: join(dir, "memory.json") },
    { onDiagnostic: (record) => diagnostics.push(record.code) },
  );
  try {
    expect(await host.remember("mixed unclassified text")).toMatchObject({
      classification: "unspecified",
      entry: { kind: "fact" },
    });
    expect(diagnostics).toContain("MEMORY_KIND_UNSPECIFIED");
    const input = {
      text: "confirmed instruction",
      kind: "constraint" as const,
      evidence: "fake",
      scope: "evil",
      speaker: "assistant",
      basis: "inference",
    };
    const result = await host.remember(input);
    expect(result.entry).toMatchObject({ speaker: "user", basis: "user", kind: "constraint" });
    expect(result.entry?.scope).toBeUndefined();
    expect(result.entry?.evidence).toMatch(/^exp:exp-.*#msg0$/);
    await expect(host.remember({ text: "bad", kind: "invalid" as "constraint" })).rejects.toThrow(
      "kind",
    );
  } finally {
    await host.close();
  }
});
