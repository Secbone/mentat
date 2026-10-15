import type { MemoryEntry, MemoryStore } from "./store";
import {
  decideWrite,
  type WriteDecision,
  type WriteOp,
  type WriteRequest,
} from "./write-rules.mjs";

export interface MemoryAuditRecord {
  ts: number;
  op: WriteOp;
  request: WriteRequest;
  entry?: MemoryEntry;
  previous?: MemoryEntry;
  reason?: string;
}

export interface MemoryAudit {
  record(record: MemoryAuditRecord): void;
}

export interface MemoryWriteResult {
  transactionId?: string;
  previous?: MemoryEntry;
  op: WriteOp;
  entry?: MemoryEntry;
  reason?: string;
}

/**
 * Compatibility service for synchronous views and offline evolution.
 * Durable stores implement atomicWrite; async callers use MemoryAccess and
 * MemoryRepository. All paths share decideWrite, including MCP.
 */
export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly audit?: MemoryAudit,
  ) {}

  write(request: WriteRequest, now = Date.now()): MemoryWriteResult {
    if (this.store.atomicWrite) return this.store.atomicWrite(request, now, this.audit);
    const decision: WriteDecision = decideWrite(this.store.list(), request, now);
    if ((decision.op === "add" || decision.op === "update") && decision.entry) {
      this.store.add(decision.entry);
    }
    try {
      this.audit?.record({
        ts: now,
        op: decision.op,
        request,
        ...(decision.entry ? { entry: decision.entry } : {}),
        ...(decision.previous ? { previous: decision.previous } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    } catch (error) {
      if (decision.entry && (decision.op === "add" || decision.op === "update")) {
        if (decision.previous) this.store.add(decision.previous);
        else this.store.forget(decision.entry.id);
      }
      throw error;
    }
    return {
      op: decision.op,
      ...(decision.entry ? { entry: decision.entry } : {}),
      ...(decision.previous ? { previous: decision.previous } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }

  list(): MemoryEntry[] {
    return this.store.list();
  }
}
