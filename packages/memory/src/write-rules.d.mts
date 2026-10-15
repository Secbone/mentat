import type { MemoryEntry } from "./store";

export interface WriteRequest {
  text: string;
  key?: string;
  kind?: MemoryEntry["kind"];
  basis?: MemoryEntry["basis"];
  scope?: string;
  condition?: string;
  /** Only explicit host user directives may activate or change an established rule. */
  status?: MemoryEntry["status"];
  evidence?: string;
  evidenceIds?: string[];
  /** Host-origin identity; never copy it from model-supplied arguments. */
  speaker?: MemoryEntry["speaker"];
  tags?: string[];
}

export type WriteOp = "add" | "update" | "dedup" | "reject";

export interface WriteDecision {
  op: WriteOp;
  entry?: MemoryEntry;
  previous?: MemoryEntry;
  reason?: string;
}

export function normalizeKey(text: string): string;
export function isRetrievable(entry: MemoryEntry, includeCandidates?: boolean): boolean;
export function deriveId(key: string): string;
export function decideWrite(
  entries: MemoryEntry[],
  request: WriteRequest,
  now: number,
): WriteDecision;
