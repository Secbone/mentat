import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryAudit, MemoryAuditRecord } from "@mentat/memory";

/** Append-only JSONL audit trail for memory writes (versions + reasons). */
export class JsonlMemoryAudit implements MemoryAudit {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  record(record: MemoryAuditRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}
