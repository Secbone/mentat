import type {
  MemoryAuditRecord,
  MemoryEntry,
  MemoryWriteResult,
  WriteRequest,
} from "@mentat/memory";
export function withMemoryLock<T>(path: string, fn: () => T): T;
export function memoryRevision(entries: MemoryEntry[]): string;
export function readMemory(path: string): MemoryEntry[];
export function mutateMemory<T>(
  path: string,
  mutate: (entries: MemoryEntry[]) => T,
  audit?: () => MemoryAuditRecord[],
  auditPath?: string,
): T;
export function commitMemory(
  path: string,
  request: WriteRequest,
  now?: number,
  expectedRevision?: string,
): MemoryWriteResult & { transactionId: string };
