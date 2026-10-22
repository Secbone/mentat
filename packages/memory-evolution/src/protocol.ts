import { digestOf, type JsonValue } from "@mentat/core";
import { defineEvalProtocol, type EvalProtocol } from "@mentat/evolution";
import type { RecallQuery } from "./evolution";

/**
 * Frozen evaluation protocol for offline memory evolution. The query set is
 * part of the protocol digest, so changing queries changes the protocol id and
 * cannot be compared with earlier scores.
 */
export function memoryEvalProtocol(
  queries: RecallQuery[],
  options: { model?: string; environment?: string } = {},
): EvalProtocol {
  return defineEvalProtocol({
    id: "memory-recall",
    version: 2,
    mode: "metric",
    dataset: {
      id: "recall-queries",
      revision: "v2",
      digest: digestOf(queries as unknown as JsonValue),
    },
    scorer: { id: "recall-task", version: "1" },
    policy: { retries: 0, abstention: "allowed" },
    ...(options.model ? { model: options.model } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
  });
}
