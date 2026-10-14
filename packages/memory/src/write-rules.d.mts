import type { MemoryEntry } from "./store";

export interface WriteRequest {
  text: string;
  key?: string;
  kind?: MemoryEntry["kind"];
  basis?: MemoryEntry["basis"];
  scope?: string;
  condition?: string;
  status?: MemoryEntry["status"];
  evidence?: string;
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
export function deriveId(key: string): string;
export function decideWrite(
  entries: MemoryEntry[],
  request: WriteRequest,
  now: number,
): WriteDecision;
