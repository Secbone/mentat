import type { TaskInput } from "@mentat/session";

/** Host policy injected when history retrieval is enabled but matched nothing. */
export const NO_EVIDENCE_POLICY =
  "No historical reference matched this question. If the answer is not supported by the current request or the provided material, say the information is unavailable instead of guessing, and do not treat an unsuccessful lookup as evidence that a fact never existed.";

/** Append the no-evidence policy to a turn input without dropping caller policy. */
export function withNoEvidencePolicy(input: TaskInput): TaskInput {
  return {
    ...input,
    hostPolicy: [input.hostPolicy, NO_EVIDENCE_POLICY]
      .filter((part): part is string => Boolean(part))
      .join(" "),
  };
}
