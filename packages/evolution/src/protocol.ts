import { type Digest, digestOf, type JsonValue } from "@mentat/core";

/**
 * How a benchmark decides whether a change is better. The protocol — not the
 * artifact — owns the scoring rule, so an artifact cannot make itself easier
 * to pass.
 */
export type EvalMode = "verifier" | "metric" | "contrastive";

export interface EvalProtocolInput {
  /** Stable protocol name, e.g. "memory-recall". */
  id: string;
  /** Bump when the dataset, scorer, budget or policy changes. */
  version: number;
  mode: EvalMode;
  dataset?: { id: string; revision: string; digest?: Digest };
  scorer?: { id: string; version: string; digest?: Digest };
  model?: string;
  budget?: { wallMs?: number; steps?: number; costUsd?: number };
  environment?: string;
  policy?: { retries?: number; abstention?: "required" | "allowed" };
}

export interface EvalProtocol extends EvalProtocolInput {
  /** Content address of the protocol definition; part of every receipt. */
  digest: Digest;
}

/** Freeze a protocol definition and content-address it. */
export function defineEvalProtocol(input: EvalProtocolInput): EvalProtocol {
  const snapshot = JSON.parse(JSON.stringify(input)) as EvalProtocolInput;
  return { ...snapshot, digest: digestOf(snapshot as unknown as JsonValue) };
}
