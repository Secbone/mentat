import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantPromptOptions, reflectMemories } from "@mentat/assistant";
import { ExperienceStore, SessionRecorder } from "@mentat/observability";
import { createAcpAdapter } from "@mentat/transport-acp";
import { saveReflections, taskContext } from "./memory";

// Two model calls: one frozen held-out constraint probe, one reflection replay.
// This is a smoke check, not a new benchmark score. Historical trial files stay intact.
const root = resolve(".mentat/experiments/personal-assistant");
const out = join(root, `context-smoke-${Date.now()}`);
mkdirSync(out);
const cwd = mkdtempSync(join(tmpdir(), "mentat-context-smoke-"));
const memory = join(out, "memory.json");
const seed = JSON.parse(readFileSync(join(root, "household-day07-memory.json"), "utf8"));
writeFileSync(memory, JSON.stringify(seed));
const model = "opencode-go/deepseek-v4.1-flash";
const adapter = createAcpAdapter({
  binary: process.execPath,
  baseArgs: [fileURLToPath(new URL("./acp-observer.mjs", import.meta.url))],
  env: {
    MENTAT_OPENCODE_BIN: "/opt/homebrew/bin/opencode",
    MENTAT_EXPERIMENT_METRICS: join(out, "native.jsonl"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model,
      small_model: model,
      autoupdate: false,
      share: "disabled",
      permission: { "*": "deny" },
      instructions: [],
    }),
  },
});
const probe = JSON.parse(
  readFileSync(join(root, "household-challenge-v5/household-challenge-C-08.json"), "utf8"),
);
const recorder = new SessionRecorder({ prompt: probe.input, cwd, harness: "acp", model });
const session = await adapter.createSession(
  { cwd, model, ...assistantPromptOptions(adapter) },
  { onPermission: { request: () => "deny" } },
);
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  const settled = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("probe timed out")), 120000);
    session.subscribe((event) => {
      recorder.handle(event);
      if (event.type === "run.settled") resolve();
    });
  });
  await Promise.all([
    session.send({ text: probe.input, context: taskContext(memory, probe.input) }),
    settled,
  ]);
} finally {
  if (timeout) clearTimeout(timeout);
  await session.dispose();
}
writeFileSync(join(out, "probe.json"), JSON.stringify(recorder.snapshot(), null, 2));

const old = JSON.parse(readFileSync(join(root, "household-C-v4/household-C-03.json"), "utf8"));
const dataset = JSON.parse(
  readFileSync(resolve("experiments/personal-assistant/cases.json"), "utf8"),
);
const feedback = dataset.scenarios.find((s: { id: string }) => s.id === "household").episodes[2]
  .afterResponseFeedback;
const first = new SessionRecorder({ prompt: old.input, cwd, harness: "acp", model });
first.handle({
  type: "message.completed",
  sessionId: "replay",
  message: { role: "assistant", text: old.first.text },
});
first.handle({ type: "run.settled", sessionId: "replay", reason: old.first.reason });
const correction = new SessionRecorder({ prompt: feedback, cwd, harness: "acp", model });
correction.handle({
  type: "message.completed",
  sessionId: "replay",
  message: { role: "assistant", text: old.revision.text },
});
correction.handle({ type: "run.settled", sessionId: "replay", reason: old.revision.reason });
const interactions = [first.snapshot(), correction.snapshot()];
const experience = new ExperienceStore(join(out, "experience"));
for (const record of interactions) experience.append(record);
const reflection = await reflectMemories(adapter, {
  cwd,
  model,
  task: old.input,
  outcome: old.revision.reason,
  tools: [],
  interactions,
});
const added = await saveReflections(memory, reflection.candidates);
writeFileSync(
  join(out, "reflection.json"),
  JSON.stringify({ replaySource: "household-C-v4/household-C-03", reflection, added }, null, 2),
);
console.log(
  JSON.stringify({ out, probe: recorder.snapshot().messages, reflection, added }, null, 2),
);
