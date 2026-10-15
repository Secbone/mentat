import type { MemoryAccess } from "@mentat/memory";
import { type ExperienceSink, messageEvidence, SessionRecorder } from "@mentat/session";
/** Only the host's explicit user command handler may call this operation. */
export async function rememberUserFact(
  memory: MemoryAccess,
  experience: ExperienceSink,
  text: string,
  cwd: string,
) {
  const recorder = new SessionRecorder({ prompt: text, cwd, harness: "manual" });
  recorder.handle({ type: "run.settled", sessionId: recorder.snapshot().id, reason: "done" });
  const record = recorder.snapshot();
  experience.append(record);
  return memory.confirm({ text, evidence: messageEvidence(record, 0) });
}
