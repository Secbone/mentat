import type {
  AdapterDeps,
  AgentEvent,
  HarnessAdapter,
  SessionHandle,
  SessionOptions,
  StopReason,
  Tracer,
  Usage,
  UserInput,
} from "@mentat/core";
import { correctiveInstruction, finalAnswerIssue } from "@mentat/core";
import { type Diagnostic, observe } from "./trajectory";

export interface TurnResult {
  turnId: string;
  sessionId: string;
  reason: StopReason;
  text: string;
  error?: string;
  usage?: Usage;
  events: AgentEvent[];
  durationMs: number;
  /** Number of corrective re-asks issued before this turn settled. */
  correctiveTurns?: number;
}
export interface TurnOptions {
  requireFinalAnswer?: boolean;
  /** Bounded corrective re-asks when the final answer is empty or leaked protocol. */
  correctiveRetries?: number;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
  tracer?: Tracer;
  onEvent?: (event: AgentEvent) => void;
  onDiagnostic?: (d: Diagnostic) => void;
  turnId?: string;
  parentSpanId?: string;
}
const running = new WeakSet<SessionHandle>();
const unusable = new WeakSet<SessionHandle>();
const disposed = new WeakSet<SessionHandle>();
export async function closeSession(session: SessionHandle, timeoutMs?: number): Promise<void> {
  if (disposed.has(session)) return;
  disposed.add(session);
  await boundedCleanup(() => session.dispose(), timeoutMs);
}
export async function boundedCleanup(action: () => Promise<void>, timeoutMs = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("session cleanup timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** send() is transport acknowledgement; run.settled is the turn boundary. */
export async function runTurn(
  session: SessionHandle,
  input: UserInput,
  options: TurnOptions = {},
): Promise<TurnResult> {
  if (running.has(session)) throw new Error("session already has an active turn");
  if (unusable.has(session)) throw new Error("session is unusable after cancellation or timeout");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("invalid turn timeout");
  running.add(session);
  const turnId = options.turnId ?? crypto.randomUUID();
  const started = Date.now();
  const events: AgentEvent[] = [];
  let text = "";
  let usage: Usage | undefined;
  let corrective = 0;
  const maxCorrective = Math.max(0, options.correctiveRetries ?? 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  let complete = false;
  const trace = (type: string, data: Record<string, import("@mentat/core").JsonValue>) =>
    observe(
      options.tracer,
      type,
      {
        turnId,
        sessionId: session.id,
        ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
        ...data,
      },
      options.onDiagnostic,
    );
  let finish!: (reason: StopReason, error?: string) => void;
  const result = new Promise<TurnResult>((resolve) => {
    finish = (reason, error) => {
      if (complete) return;
      complete = true;
      if (!events.some((event) => event.type === "run.settled")) {
        const terminal: AgentEvent = {
          type: "run.settled",
          sessionId: session.id,
          reason,
          ...(error ? { error } : {}),
        };
        events.push(terminal);
        trace(
          "agent.event",
          terminal as unknown as Record<string, import("@mentat/core").JsonValue>,
        );
        try {
          options.onEvent?.(terminal);
        } catch (observerError) {
          options.onDiagnostic?.({ code: "OBSERVER_FAILED", message: String(observerError) });
        }
      }
      trace("turn.end", { reason, error: error ?? null, durationMs: Date.now() - started });
      resolve({
        turnId,
        sessionId: session.id,
        reason,
        text,
        ...(error ? { error } : {}),
        ...(usage ? { usage } : {}),
        events,
        durationMs: Date.now() - started,
        ...(corrective > 0 ? { correctiveTurns: corrective } : {}),
      });
    };
  });
  const abort = () => {
    unusable.add(session);
    finish("aborted", "turn cancelled");
  };
  try {
    trace("turn.start", { input: input as unknown as import("@mentat/core").JsonValue });
    unsubscribe = session.subscribe((event) => {
      if (complete) return;
      if (event.sessionId !== session.id) {
        trace("invariant.violation", { code: "SESSION_MISMATCH", eventSessionId: event.sessionId });
        return;
      }
      if (event.type === "run.settled" && event.reason === "done" && options.requireFinalAnswer) {
        const issue = finalAnswerIssue(text);
        if (issue) {
          if (corrective < maxCorrective) {
            corrective += 1;
            trace("output.corrective", { issue, attempt: corrective, maxCorrective });
            text = "";
            const retry: UserInput = { text: correctiveInstruction(issue) };
            void Promise.resolve()
              .then(() => session.send(retry))
              .catch((error) => {
                unusable.add(session);
                finish("error", String(error));
              });
            return;
          }
          trace("output.invalid", { issue, transportReason: event.reason });
          event = { ...event, reason: "error", error: `invalid final answer: ${issue}` };
        }
      }
      events.push(structuredClone(event));
      trace("agent.event", event as unknown as Record<string, import("@mentat/core").JsonValue>);
      if (event.type === "message.completed") text = event.message.text;
      if (event.type === "usage") usage = event.usage;
      try {
        options.onEvent?.(event);
      } catch (error) {
        options.onDiagnostic?.({ code: "OBSERVER_FAILED", message: String(error) });
      }
      if (event.type === "run.settled") finish(event.reason, event.error);
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      unusable.add(session);
      finish("error", "turn timed out");
    }, timeoutMs);
    if (options.signal?.aborted) abort();
    else
      void Promise.resolve()
        .then(() => {
          if (!complete) return session.send(input);
        })
        .catch((error) => {
          unusable.add(session);
          finish("error", String(error));
        });
    return await result;
  } catch (error) {
    unusable.add(session);
    finish("error", String(error));
    return await result;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    if (unusable.has(session)) {
      try {
        await boundedCleanup(() => session.interrupt(), options.cleanupTimeoutMs);
      } catch (error) {
        trace("session.cleanup.error", { error: String(error) });
      }
      try {
        await closeSession(session, options.cleanupTimeoutMs);
      } catch (error) {
        trace("session.cleanup.error", { error: String(error) });
      }
    }
    running.delete(session);
  }
}
export async function runOnce(
  adapter: HarnessAdapter,
  sessionOptions: SessionOptions,
  input: UserInput,
  options: TurnOptions & { deps?: AdapterDeps } = {},
): Promise<TurnResult> {
  observe(
    options.tracer,
    "session.create.start",
    { harness: adapter.id, options: sessionOptions as unknown as import("@mentat/core").JsonValue },
    options.onDiagnostic,
  );
  let session: SessionHandle;
  try {
    session = await openSession(adapter, sessionOptions, options.deps, options);
  } catch (error) {
    observe(options.tracer, "session.create.error", { error: String(error) }, options.onDiagnostic);
    throw error;
  }
  try {
    return await runTurn(session, input, options);
  } finally {
    if (!unusable.has(session)) await closeSession(session, options.cleanupTimeoutMs);
  }
}

/** Bound startup too; late-created sessions are disposed rather than leaked. */
export async function openSession(
  adapter: HarnessAdapter,
  sessionOptions: SessionOptions,
  deps: AdapterDeps | undefined,
  options: TurnOptions = {},
): Promise<SessionHandle> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("invalid session timeout");
  if (options.signal?.aborted) throw new Error("session creation cancelled");
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const creation = Promise.resolve().then(() => {
    if (expired) throw new Error("session creation cancelled");
    return adapter.createSession(sessionOptions, deps);
  });
  void creation.then(
    async (session) => {
      if (expired)
        try {
          await closeSession(session, options.cleanupTimeoutMs);
        } catch (error) {
          options.onDiagnostic?.({ code: "LATE_SESSION_CLEANUP", message: String(error) });
        }
    },
    () => {},
  );
  try {
    return await Promise.race([
      creation,
      new Promise<SessionHandle>((_, reject) => {
        abort = () => {
          expired = true;
          reject(new Error("session creation cancelled"));
        };
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("session creation timed out"));
        }, timeoutMs);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
