import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter, type UserInput } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import { createMemoryAccess } from "@mentat/memory";
import { FileMemoryRepository } from "@mentat/memory-file";
import { ExperienceStore } from "@mentat/observability";
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
  expect(new ExperienceStore(experienceDir).list().map((record) => record.scope)).toEqual([
    "alice",
    "bob",
    "alice",
    "alice",
  ]);
});
