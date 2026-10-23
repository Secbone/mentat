import type { TaskAcceptance } from "@mentat/core";
import type { TaskInput, TurnResult } from "@mentat/session";

export interface ResultEvaluator {
  id: string;
  timeoutMs?: number;
  evaluate(context: {
    input: TaskInput;
    result: TurnResult;
    signal: AbortSignal;
  }): Promise<Omit<TaskAcceptance, "evaluator">>;
}

/** Trusted, read-only evaluator; never replays model tools or retries a task. */
export async function evaluateResult(
  evaluator: ResultEvaluator,
  input: TaskInput,
  result: TurnResult,
  parent: AbortSignal,
): Promise<TaskAcceptance> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    const decision = await new Promise<Omit<TaskAcceptance, "evaluator">>((resolve, reject) => {
      abort = () => reject(new Error("result evaluation cancelled or timed out"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => controller.abort(), evaluator.timeoutMs ?? 30000);
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return evaluator.evaluate({
            input: structuredClone(input),
            result: structuredClone(result),
            signal,
          });
        })
        .then(resolve, reject);
    });
    if (
      !decision ||
      !["accepted", "rejected", "error", "not-evaluated"].includes(decision.status) ||
      !Array.isArray(decision.issues) ||
      decision.issues.some((issue) => typeof issue !== "string") ||
      (decision.status === "accepted" && decision.issues.length)
    )
      throw new Error("invalid result evaluation decision");
    if (
      decision.status === "accepted" &&
      (result.reason === "error" || result.reason === "aborted")
    )
      return {
        evaluator: evaluator.id,
        status: "rejected",
        issues: [`execution ended: ${result.reason}`],
        ...(decision.evidence !== undefined
          ? { evidence: structuredClone(decision.evidence) }
          : {}),
      };
    return { ...structuredClone(decision), evaluator: evaluator.id };
  } catch (error) {
    return { evaluator: evaluator.id, status: "error", issues: [String(error)] };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
