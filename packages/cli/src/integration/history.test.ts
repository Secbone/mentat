import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import { FileMemoryRepository } from "@mentat/memory-file";
import { ExperienceStore } from "@mentat/observability";
import { expect, it } from "vitest";

it("marks the absence of matching evidence so the model abstains instead of guessing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-history-none-"));
  const host = createAssistantHost({
    cwd: root,
    adapter: createFakeAdapter(),
    memoryPath: join(root, "memory.json"),
    experienceDir: join(root, "experience"),
    history: { maxChars: 3000 },
  });
  try {
    await host.ingestHistory([
      {
        id: "past",
        source: "fixture",
        timestamp: Date.UTC(2025, 0, 1),
        messages: [{ role: "user", content: "My cat is Luna." }],
      },
    ]);
    const s = await host.open();
    await host.turn(s, "What is my passport number?");
    await host.close();
    if (!host.logDir) throw new Error("history test requires file tracing");
    const events = readFileSync(join(host.logDir, "events.jsonl"), "utf8");
    expect(events).toContain("No historical reference matched this question");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("imports history idempotently, persists reference retrieval and never confirms inferred rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "mentat-history-"));
  const memoryPath = join(root, "memory.json"),
    experienceDir = join(root, "experience");
  const host = createAssistantHost({
    cwd: root,
    adapter: createFakeAdapter(),
    memoryPath,
    experienceDir,
    history: { maxChars: 3000 },
  });
  const history = [
    {
      id: "past",
      source: "fixture",
      timestamp: Date.UTC(2025, 0, 1),
      messages: [{ role: "user", content: "My cat is Luna. I prefer short lists." }],
    },
  ];
  try {
    expect(await host.ingestHistory(history)).toEqual({ added: 1, skipped: 0 });
    expect(await host.ingestHistory(history)).toEqual({ added: 0, skipped: 1 });
    await expect(
      host.ingestHistory([{ ...history[0], messages: [{ role: "user", content: "changed" }] }]),
    ).rejects.toThrow("identity changed");
    expect((await new FileMemoryRepository(memoryPath).snapshot()).entries).toEqual([]);
    const s = await host.open();
    const { result } = await host.turn(s, "What is my cat's name?");
    expect(result.reason).toBe("done");
    const store = new ExperienceStore(experienceDir);
    expect(store.list().filter((r) => r.imported)).toHaveLength(1);
    await host.close();
    if (!host.logDir) throw new Error("history test requires file tracing");
    const events = readFileSync(join(host.logDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"history.selection"');
    expect(events).toContain("Luna");
    expect((await new FileMemoryRepository(memoryPath).snapshot()).entries).toEqual([]);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
