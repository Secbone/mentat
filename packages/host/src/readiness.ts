import type { TurnResult } from "@mentat/session";

export interface ReadinessProbe {
  toolName: string;
  expectedOutput: string;
  maxAttempts?: number;
}

/**
 * Verify a read-only tool actually executes before any user task is submitted.
 * A previous unexecuted call is never a successful probe. Throws if unverified,
 * so the caller can close the half-open session and fail the run.
 */
export async function verifyReadiness(options: {
  sessionId: string;
  probe: ReadinessProbe;
  probeTurn: () => Promise<TurnResult>;
  emit: (type: string, data: unknown) => void;
}): Promise<void> {
  const { probe, emit, sessionId } = options;
  let verified = false;
  for (let attempt = 1; attempt <= (probe.maxAttempts ?? 2); attempt++) {
    emit("session.readiness.start", { sessionId, attempt, tool: probe.toolName });
    const result = await options.probeTurn();
    const ids = new Set(
      result.events
        .filter((event) => event.type === "tool.start" && event.name === probe.toolName)
        .map((event) => (event.type === "tool.start" ? event.id : "")),
    );
    verified =
      !result.events.some(
        (event) => event.type === "tool.start" && event.name !== probe.toolName,
      ) &&
      result.events.some(
        (event) =>
          event.type === "tool.result" &&
          ids.has(event.id) &&
          !event.isError &&
          event.output.includes(probe.expectedOutput),
      );
    emit("session.readiness.end", { sessionId, attempt, verified, reason: result.reason });
    if (verified) break;
    if (result.reason === "aborted" || result.error === "turn timed out") break;
  }
  if (!verified) throw new Error("startup tool probe failed; no user task submitted");
}

export const READINESS_PROBE_POLICY =
  "This is a setup probe, not a user task. Use the actual named read-only tool. Do not simulate a call, read/write user memory, or use other tools. A previous unexecuted call is not a successful probe.";
