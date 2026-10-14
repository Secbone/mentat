import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  op: WriteOp;
  entry?: MemoryEntry;
  reason?: string;
}

/**
 * The single entry point for writing memory. CLI manual writes, the MCP tool,
 * and online reflection all go through here, so every path applies the same
 * source/scope checks, key-based dedup and versioning, and records an audit
 * trail. (Offline evolution writes a versioned artifact through a workspace and
 * is not yet routed here.)
 */
export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly audit?: MemoryAudit,
  ) {}

  write(request: WriteRequest, now = Date.now()): MemoryWriteResult {
    const decision: WriteDecision = decideWrite(this.store.list(), request, now);
    if ((decision.op === "add" || decision.op === "update") && decision.entry) {
      this.store.add(decision.entry);
    }
    this.audit?.record({
      ts: now,
      op: decision.op,
      request,
      ...(decision.entry ? { entry: decision.entry } : {}),
      ...(decision.previous ? { previous: decision.previous } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    });
    return {
      op: decision.op,
      ...(decision.entry ? { entry: decision.entry } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }

  list(): MemoryEntry[] {
    return this.store.list();
  }
}

/** Append-only JSONL audit trail for memory writes (versions + reasons). */
export class JsonlMemoryAudit implements MemoryAudit {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  record(record: MemoryAuditRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}
