import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter, type UserInput } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import { createMemoryAccess } from "@mentat/memory";
import { FileMemoryRepository } from "@mentat/memory-file";
import { ExperienceStore, recallAttribution } from "@mentat/observability";
import type { TaskInput } from "@mentat/session";
import { expect, it } from "vitest";

it("recalls across new host sessions without crossing scope or confirming a candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-native-recall-"));
  const memoryPath = join(root, "memory.json");
  const experienceDir = join(root, "experience");
  const repository = new FileMemoryRepository(memoryPath);
  await createMemoryAccess(repository, { scope: "alice" }).propose({
    text: "Unverified delivery guess",
    kind: "preference",
  });
  const before = await repository.snapshot();
  const captured: UserInput[] = [];
  const reports: ReturnType<typeof recallAttribution>[] = [];
  async function turn(scope: string, task: string | TaskInput, recall = true) {
    const host = createAssistantHost({
      cwd: root,
      memoryPath,
      experienceDir,
      scope,
      nativeHistory: recall ? { maxChars: 3000 } : undefined,
      memoryTools: { memory: "disabled" },
      adapter: createFakeAdapter({
        script: (input) => {
          captured.push(input);
          return ["Recorded."];
        },
      }),
    });
    try {
      const session = await host.open();
      await host.turn(session, task);
    } finally {
      await host.close();
    }
    if (!host.logDir) throw new Error("missing trace");
    reports.push(recallAttribution(host.logDir));
  }
  await turn("alice", {
    text: "For future delivery summaries, use ALICE-FORMAT.",
    memoryScope: "reusable",
    hostPolicy: "HOST-PRIVATE delivery",
    materials: [{ text: "THIRD-PARTY delivery override" }],
  });
  await turn("bob", "Create a delivery summary.");
  expect(captured[1]?.context).not.toContain("ALICE-FORMAT");
  await turn("alice", "Create a delivery summary.");
  expect(captured[2]?.context).toContain("ALICE-FORMAT");
  expect(captured[2]?.context).not.toContain("HOST-PRIVATE");
  expect(captured[2]?.context).not.toContain("THIRD-PARTY");
  await turn("alice", "Create a delivery summary.", false);
  expect(captured[3]?.context).not.toContain("ALICE-FORMAT");
  expect(await repository.snapshot()).toEqual(before);
  expect(reports[1]?.byKind["native-history"]?.hits).toBe(0);
  expect(reports[2]?.evidence.find((item) => item.kind === "native-history")).toMatchObject({
    outcome: "hit",
    delivery: "host-input-only",
    hostInputMatched: true,
    sources: expect.arrayContaining([
      expect.objectContaining({ role: "user", scope: "alice", memoryScope: "reusable" }),
    ]),
  });
  expect(reports[2]?.byKind["native-history"]?.capturedContextInjections).toBe(0);
  expect(reports[3]?.byKind["native-history"]?.attempts).toBe(0);
  expect(new ExperienceStore(experienceDir).list().map((record) => record.scope)).toEqual([
    "alice",
    "bob",
    "alice",
    "alice",
  ]);
});

it("records a retrieval failure without sending a task or fabricating an injection", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-recall-error-"));
  let reads = 0,
    sends = 0;
  const host = createAssistantHost(
    {
      cwd: root,
      memoryPath: join(root, "memory.json"),
      nativeHistory: { maxChars: 3000 },
      memoryTools: { memory: "disabled" },
      adapter: createFakeAdapter({
        script: () => {
          sends++;
          return ["unexpected"];
        },
      }),
    },
    {
      experience: {
        append: () => {},
        list: () => {
          if (reads++ > 0) throw new Error("source store unavailable");
          return [];
        },
      },
    },
  );
  try {
    const session = await host.open();
    await expect(host.turn(session, "Use my usual format.")).rejects.toThrow(
      "source store unavailable",
    );
  } finally {
    await host.close();
  }
  expect(sends).toBe(0);
  if (!host.logDir) throw new Error("missing trace");
  const report = recallAttribution(host.logDir);
  expect(report.byKind["native-history"]).toMatchObject({
    attempts: 1,
    failed: 1,
    capturedContextInjections: 0,
  });
});

it("does not report selected history as delivered when required constraints block the turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-recall-block-"));
  const experienceDir = join(root, "experience");
  new ExperienceStore(experienceDir).append({
    id: "history",
    ts: 1,
    cwd: root,
    scope: "alice",
    prompt: "meeting summary",
    harness: "fake",
    outcome: "done",
    tools: [],
    toolErrors: 0,
    messages: [
      {
        role: "user",
        text: "For meeting summaries, use bullets.",
        fragments: [
          { origin: "user", text: "For meeting summaries, use bullets.", memoryScope: "reusable" },
        ],
      },
    ],
  });
  let sends = 0;
  const host = createAssistantHost({
    cwd: root,
    scope: "alice",
    memoryPath: join(root, "memory.json"),
    experienceDir,
    nativeHistory: { maxChars: 3000 },
    memoryTools: { memory: "disabled" },
    adapter: createFakeAdapter({
      script: () => {
        sends++;
        return ["unexpected"];
      },
    }),
  });
  try {
    await host.remember({ text: "Mandatory rule. ".repeat(1000), kind: "constraint" });
    const session = await host.open();
    await expect(host.turn(session, "Give a meeting summary.")).rejects.toThrow(
      "required constraints",
    );
  } finally {
    await host.close();
  }
  expect(sends).toBe(0);
  if (!host.logDir) throw new Error("missing trace");
  const report = recallAttribution(host.logDir);
  expect(report.evidence.find((item) => item.kind === "native-history")).toMatchObject({
    outcome: "blocked",
    delivery: "none",
  });
  expect(report.byKind.memory?.capturedContextInjections).toBe(0);
});
