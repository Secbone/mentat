import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue, Tracer } from "@mentat/core";

/** Append-only JSONL tracer. Every emit becomes one line, fsync-free. */
export class JsonlTracer implements Tracer {
  private readonly path: string;
  private readonly meta: Record<string, JsonValue>;

  constructor(path: string, meta: Record<string, JsonValue> = {}) {
    this.path = path;
    this.meta = meta;
    mkdirSync(dirname(path), { recursive: true });
  }

  emit(type: string, data?: JsonValue): void {
    const event: Record<string, JsonValue> = { ts: Date.now(), type, ...this.meta };
    if (data !== undefined) event.data = data;
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }
}
