import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkSubject, EpisodeInput, SubjectFactory } from "@mentat/benchmark";
import type { CapabilityPack } from "@mentat/pack";
import type { WorkerAdapter, WorkerEvent } from "@mentat/worker";

export interface WorkerSubjectOptions {
  worker: WorkerAdapter;
  cwd: string;
  /** Evidence directory; omitted keeps only session ids in evidence. */
  out?: string;
  /** Run every benchmark turn through the worker adapter. */
  timeoutMs?: number;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Adapt a WorkerAdapter to the benchmark subject contract. One worker spawn is
 * one benchmark turn; explicit memories are replayed into later turns sharing
 * the same benchmark state key.
 */
export function workerSubjectFactory(
  options: WorkerSubjectOptions,
): (pack: CapabilityPack) => SubjectFactory {
  return (pack) => {
    const memories = new Map<string, string[]>();
    const evaluation = crypto.randomUUID();
    return async ({ stateKey, unit }) => {
      const remembered = memories.get(stateKey) ?? [];
      memories.set(stateKey, remembered);
      const trial = hash(
        JSON.stringify([evaluation, pack.digest, stateKey, unit.caseId, unit.arm, unit.repetition]),
      );
      const evidence: string[] = [];
      let turns = 0;

      return {
        async turn(input: EpisodeInput) {
          const prompt = [input.hostPolicy, ...remembered, input.text]
            .filter((part): part is string => Boolean(part))
            .join("\n\n");
          const session = await options.worker.spawn({
            assignmentId: `${pack.id}-${trial}-${turns}`,
            ticketId: `${unit.caseId}-${unit.arm}-${unit.repetition}`,
            cwd: options.cwd,
            prompt,
            pack,
          });
          const events: WorkerEvent[] = [];
          let costUsd: number | null = null;
          try {
            for await (const event of session.events()) {
              events.push(event);
              if (event.type === "usage" && event.costUsd !== undefined)
                costUsd = (costUsd ?? 0) + event.costUsd;
            }
            const report = await session.report();
            const path = record(options.out, trial, turns++, input, report, events);
            evidence.push(...(path ? [path] : [`worker:${options.worker.id}:${session.id}`]));
            return {
              text: report.text ?? report.summary,
              ok: report.kind === "ready",
              costUsd,
              evidence,
            };
          } finally {
            await session.dispose();
          }
        },
        async remember(input) {
          remembered.push(`[${input.kind}] ${input.text}${input.key ? ` (${input.key})` : ""}`);
        },
        async reflect() {
          return { costUsd: null, evidence };
        },
        async close() {
          return { costUsd: null, evidence };
        },
      } satisfies BenchmarkSubject;
    };
  };
}

function record(
  out: string | undefined,
  trial: string,
  turn: number,
  input: EpisodeInput,
  report: unknown,
  events: WorkerEvent[],
): string | undefined {
  if (!out) return undefined;
  const dir = join(out, trial);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `turn-${turn}.json`);
  writeFileSync(path, JSON.stringify({ input, report, events }, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return path;
}
