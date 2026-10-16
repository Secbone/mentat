import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTurnContext, InMemoryMemoryStore, type MemoryEntry } from "@mentat/memory";

/** Offline counterfactual, never changes the experiment's live memories or calls a model. */
export function pressureProbe(profile: MemoryEntry, maxChars = 6000) {
  const noise: MemoryEntry = {
    id: "unrelated-budget-filler",
    text: "",
    kind: "fact",
    basis: "user",
    status: "active",
    createdAt: profile.createdAt + 1000,
  };
  const view = new InMemoryMemoryStore();
  view.add(noise);
  const overhead = buildTurnContext(view, "unrelated-probe", maxChars).text.length;
  noise.text = "x".repeat(maxChars - overhead);
  view.add(noise);
  view.add(profile);
  const observed = buildTurnContext(view, "unrelated-probe", maxChars);
  const counterfactual = new InMemoryMemoryStore();
  counterfactual.add(noise);
  counterfactual.add({ ...profile, kind: "constraint" });
  const typed = buildTurnContext(counterfactual, "unrelated-probe", maxChars);
  return {
    profileId: profile.id,
    profileKind: profile.kind,
    profileChars: profile.text.length,
    maxChars,
    observed: {
      selected: observed.selectedIds.includes(profile.id),
      required: observed.requiredIds.includes(profile.id),
      omittedRequired: observed.omittedRequiredIds.includes(profile.id),
      decisions: observed.decisions,
    },
    typedCounterfactual: {
      selected: typed.selectedIds.includes(profile.id),
      required: typed.requiredIds.includes(profile.id),
      omittedRequired: typed.omittedRequiredIds.includes(profile.id),
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? ".mentat/experiments/multiturn-20261015-v2");
  const rows = readFileSync(join(root, "results.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { id: string; arm: string; task: string; memoryAfter: MemoryEntry[] },
    );
  const result = rows
    .filter((row) => row.arm === "persistent" && row.task === "learn")
    .flatMap((row) =>
      row.memoryAfter
        .filter((entry) => entry.status === "active")
        .map((entry) => ({ id: row.id, ...pressureProbe(entry) })),
    );
  writeFileSync(join(root, "pressure.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
