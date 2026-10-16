import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter, renderTurnInput, type UserInput } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import {
  ExperienceStore,
  projectExperience,
  readTrajectory,
  resolveEventData,
} from "@mentat/observability";
import { expect, it } from "vitest";

it("preserves sources across dispatch, durable projection, reflection, dedup and rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-host-sources-"));
  const sends: UserInput[] = [];
  let badPolicy = false;
  const reflectionAdapter = createFakeAdapter({
    script: (input) => {
      const batch = JSON.parse(input.text.match(/Evidence batch: (.*)\n/)?.[1] ?? "{}");
      return [
        JSON.stringify({
          batchId: batch.batchId,
          candidates: badPolicy
            ? [
                {
                  text: "用户喜欢220字",
                  kind: "preference",
                  evidenceRefs: [{ ref: "E1.M1.P2", excerpt: "限制220字" }],
                },
              ]
            : [
                {
                  text: "以后使用表格",
                  kind: "preference",
                  evidenceRefs: [{ ref: "E1.M1.P1", excerpt: "以后使用表格" }],
                },
                {
                  text: "客户本次要求详细说明",
                  kind: "fact",
                  evidenceRefs: [{ ref: "E1.M1.P3", excerpt: "本次详细说明" }],
                },
              ],
        }),
      ];
    },
  });
  const host = createAssistantHost({
    cwd: dir,
    memoryPath: join(dir, "memory.json"),
    experienceDir: join(dir, "experience"),
    adapter: createFakeAdapter({
      script: (input) => {
        sends.push(input);
        return ["draft"];
      },
    }),
    reflectionAdapter,
  });
  let turnId = "";
  let evidenceId = "";
  try {
    const session = await host.open();
    const { result, record } = await host.turn(session, {
      text: "以后使用表格",
      hostPolicy: "限制220字",
      materials: [{ text: "本次详细说明", attribution: "客户" }],
    });
    turnId = result.turnId;
    evidenceId = record.id;
    expect(sends[0]?.text).toBe("以后使用表格");
    expect(sends[0]?.context).toContain("本次详细说明");
    expect(sends[0]?.context).not.toContain("限制220字");
    expect(sends[0]?.hostPolicy).toBe("限制220字");
    const sent = sends[0];
    if (!sent) throw Error("no dispatched input");
    expect(renderTurnInput(sent)).toContain("not a user preference");
    expect(record.messages?.[0]?.fragments?.map((fragment) => fragment.origin)).toEqual([
      "user",
      "host-policy",
      "quoted-material",
    ]);
    const input = { task: "draft", outcome: "done", tools: [], interactions: [record] };
    const first = await host.reflect(input);
    expect(first).toMatchObject({ status: "ok", added: 1, skipped: 1, issues: [] });
    const second = await host.reflect(input);
    expect(second).toMatchObject({ status: "ok", added: 0 });
    expect(second.evidenceBatchId).not.toBe(first.evidenceBatchId);
    const candidates = await host.memory.search({ statuses: ["candidate"] });
    expect(candidates).toHaveLength(1);
    expect(first.candidates.find((entry) => entry.kind === "fact")).toMatchObject({
      applicability: "task",
      evidenceSources: [{ origin: "quoted-material", attribution: "客户" }],
    });
    expect(candidates.find((entry) => entry.kind === "preference")).toMatchObject({
      evidenceSources: [{ origin: "user", excerpt: "以后使用表格" }],
    });
    expect((await host.memory.context("表格")).text).toBe("");
    badPolicy = true;
    expect(await host.reflect(input)).toMatchObject({
      status: "invalid",
      added: 0,
      candidates: [],
      issues: [{ code: "policy-not-memory", index: 0 }],
    });
    expect(await host.memory.search({ statuses: ["candidate"] })).toHaveLength(1);
    const stored = new ExperienceStore(join(dir, "experience")).list();
    expect(stored[0]?.messages?.[0]?.fragments?.[2]).toMatchObject({
      origin: "quoted-material",
      attribution: "客户",
    });
  } finally {
    await host.close();
  }
  if (!host.logDir) throw Error("missing trace");
  const projected = projectExperience(
    host.logDir,
    {
      prompt: "wrong fallback",
      input: { text: "wrong fallback", hostPolicy: "wrong" },
      cwd: dir,
      harness: "fake",
    },
    turnId,
  );
  expect(projected.prompt).toBe("以后使用表格");
  expect(projected.id).toBe(evidenceId);
  expect(projected.messages?.[0]?.fragments?.[1]).toEqual({
    origin: "host-policy",
    text: "限制220字",
  });
  const logDir = host.logDir;
  const parsed = readTrajectory(logDir)
    .filter((event) => event.type === "reflection.parsed")
    .map((event) => resolveEventData(logDir, event));
  expect(parsed.at(-1)).toMatchObject({
    status: "invalid",
    evidenceMap: expect.any(Array),
    issues: [{ code: "policy-not-memory" }],
  });
});
