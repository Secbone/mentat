import {
  ExperienceStore,
  JsonFileMemoryStore,
  JsonlMemoryAudit,
  MemoryService,
  messageEvidence,
  SessionRecorder,
} from "@mentat/memory";

/** Only explicit host user directives use this path; never model tool calls. */
export function rememberUserFact(
  memoryPath: string,
  experienceDir: string,
  text: string,
  cwd = process.cwd(),
) {
  const recorder = new SessionRecorder({ prompt: text, cwd, harness: "manual" });
  recorder.handle({ type: "run.settled", sessionId: recorder.snapshot().id, reason: "done" });
  const record = recorder.snapshot();
  new ExperienceStore(experienceDir).append(record);
  return new MemoryService(
    new JsonFileMemoryStore(memoryPath),
    new JsonlMemoryAudit(`${memoryPath}.audit.jsonl`),
  ).write({
    text,
    basis: "user",
    speaker: "user",
    evidence: messageEvidence(record, 0),
  });
}
