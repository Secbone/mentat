import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { afterEach, expect, it, vi } from "vitest";
import { evolveCommand } from "../commands/evolve";

const captured = vi.hoisted(() => ({
  prompts: [] as string[],
  adapter: undefined as ReturnType<typeof createFakeAdapter> | undefined,
}));
vi.mock("../lib/registry", () => ({
  createDefaultRegistry: () => ({ get: () => captured.adapter }),
}));
afterEach(() => vi.restoreAllMocks());

it("sends training examples but never the held-out query or expected identity to the proposer", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const dir = mkdtempSync(join(tmpdir(), "mentat-holdout-")),
    training = join(dir, "train.json"),
    heldout = join(dir, "test.json");
  const finalTest = join(dir, "final.json");
  writeFileSync(
    finalTest,
    JSON.stringify([{ query: "FINAL_UNSEEN_QUERY", expectId: "FINAL_UNSEEN_ID" }]),
  );
  writeFileSync(training, JSON.stringify([{ query: "training build", expectId: "build" }]));
  writeFileSync(
    heldout,
    JSON.stringify([{ query: "PRIVATE_HELDOUT_QUERY", expectId: "PRIVATE_HELDOUT_ID" }]),
  );
  captured.prompts = [];
  captured.adapter = createFakeAdapter({
    script: (input) => {
      captured.prompts.push(input.text);
      return ['[{"id":"build","text":"training build","createdAt":1}]'];
    },
  });
  const args = [
    "memory",
    "--agent",
    "--training-queries",
    training,
    "--queries",
    heldout,
    "--test-queries",
    finalTest,
    "--store",
    join(dir, "store"),
    "--memory",
    join(dir, "memory.json"),
    "--log-dir",
    join(dir, "logs"),
  ];
  expect(await evolveCommand(args)).toBe(0);
  expect(captured.prompts).toHaveLength(1);
  expect(captured.prompts[0]).toContain("training build");
  expect(captured.prompts[0]).not.toContain("PRIVATE_HELDOUT");
  expect(captured.prompts[0]).not.toContain("FINAL_UNSEEN");
  const trace = readdirSync(join(dir, "logs"))[0];
  if (!trace) throw new Error("missing evolution trace");
  const final = JSON.parse(readFileSync(join(dir, "logs", trace, "final-evaluation.json"), "utf8"));
  expect(final.candidateId).toBe("root");
  const events = readFileSync(join(dir, "logs", trace, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(events.filter((row) => row.type === "evaluation.final")).toHaveLength(1);
  writeFileSync(training, JSON.stringify([{ query: "private_heldout_query", expectId: "build" }]));
  await expect(evolveCommand(args)).rejects.toThrow("queries overlap");
  expect(captured.prompts).toHaveLength(1);
});
