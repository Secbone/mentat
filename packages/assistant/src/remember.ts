import type { MemoryAccess, MemoryKind } from "@mentat/memory";
import { type ExperienceSink, messageEvidence, SessionRecorder } from "@mentat/session";

/** Trusted explicit user command input, never model-supplied confirmation. */
export type RememberInput =
  | string
  | {
      text: string;
      kind: Exclude<MemoryKind, "candidate">;
      key?: string;
      condition?: string;
    };

/** Only the host's explicit user command handler may call this operation. */
export async function rememberUserFact(
  memory: MemoryAccess,
  experience: ExperienceSink,
  input: RememberInput,
  cwd: string,
) {
  const text = typeof input === "string" ? input : input.text;
  if (
    typeof input !== "string" &&
    !["fact", "preference", "constraint", "method"].includes(input.kind)
  )
    throw new TypeError("remember requires fact, preference, constraint or method kind");
  const recorder = new SessionRecorder({
    prompt: text,
    input: { text, memoryScope: "reusable" },
    cwd,
    harness: "manual",
  });
  recorder.handle({ type: "run.settled", sessionId: recorder.snapshot().id, reason: "done" });
  const record = recorder.snapshot();
  experience.append(record);
  const pointer = messageEvidence(record, 0);
  // Explicit allowlist: caller-provided evidence, identity and status cannot cross this boundary.
  const result = await memory.confirm({
    text,
    ...(typeof input === "string"
      ? {}
      : {
          kind: input.kind,
          ...(input.key !== undefined ? { key: input.key } : {}),
          ...(input.condition !== undefined ? { condition: input.condition } : {}),
        }),
    evidence: pointer,
    evidenceIds: [record.id],
    evidenceSources: [{ pointer, origin: "user", excerpt: text, memoryScope: "reusable" }],
    applicability: "reusable",
  });
  return {
    ...result,
    classification:
      typeof input !== "string"
        ? ("explicit" as const)
        : result.previous?.kind
          ? ("inherited" as const)
          : ("unspecified" as const),
  };
}
