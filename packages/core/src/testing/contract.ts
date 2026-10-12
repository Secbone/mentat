import { describe, expect, it } from "vitest";
import type { HarnessAdapter, SessionHandle, UserInput } from "../adapter";
import type { AgentEvent } from "../events";

export interface RunRecord {
  events: AgentEvent[];
  end: AgentEvent;
}

/** Subscribe, send one input, and resolve when the run settles. */
export async function runOnce(session: SessionHandle, input: UserInput): Promise<RunRecord> {
  const events: AgentEvent[] = [];
  let resolveSettled!: (event: AgentEvent) => void;
  const settled = new Promise<AgentEvent>((resolve) => {
    resolveSettled = resolve;
  });
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
    if (event.type === "run.settled") resolveSettled(event);
  });
  try {
    await session.send(input);
    const end = await settled;
    return { events, end };
  } finally {
    unsubscribe();
  }
}

/**
 * The contract every {@link HarnessAdapter} must satisfy. Reused by every
 * real adapter (Pi, opencode, ...) so the abstraction stays honest.
 */
export function describeHarnessContract(
  label: string,
  create: () => Promise<HarnessAdapter> | HarnessAdapter,
): void {
  describe(`${label} harness contract`, () => {
    it("streams text and settles exactly once with reason done", async () => {
      const adapter = await create();
      const session = await adapter.createSession({ cwd: process.cwd() });
      const { events, end } = await runOnce(session, { text: "hello mentat" });

      expect(end).toMatchObject({ type: "run.settled", reason: "done" });
      expect(events.filter((e) => e.type === "run.settled")).toHaveLength(1);
      expect(events.some((e) => e.type === "run.started")).toBe(true);

      const deltas = events.filter((e) => e.type === "message.delta");
      expect(deltas.length).toBeGreaterThan(0);

      const completed = events.find((e) => e.type === "message.completed");
      expect(completed).toBeDefined();
      if (completed?.type === "message.completed") {
        const streamed = deltas
          .filter(
            (e): e is Extract<AgentEvent, { type: "message.delta" }> => e.type === "message.delta",
          )
          .map((e) => e.text)
          .join("");
        expect(completed.message.text).toBe(streamed);
      }

      await session.dispose();
    });

    it("stops delivering to unsubscribed listeners", async () => {
      const adapter = await create();
      const session = await adapter.createSession({ cwd: process.cwd() });
      let count = 0;
      const unsubscribe = session.subscribe(() => {
        count += 1;
      });
      unsubscribe();
      await session.send({ text: "quiet" });
      expect(count).toBe(0);
      await session.dispose();
    });

    it("settles as aborted when interrupted mid-run", async () => {
      const adapter = await create();
      const session = await adapter.createSession({ cwd: process.cwd() });
      let interrupted = false;
      session.subscribe((event) => {
        if (event.type === "message.delta" && !interrupted) {
          interrupted = true;
          void session.interrupt();
        }
      });
      const { end } = await runOnce(session, { text: "abcdefghij" });
      expect(end).toMatchObject({ type: "run.settled", reason: "aborted" });
      await session.dispose();
    });
  });
}
