import type { JsonValue } from "./types";

/** One structured observation emitted during a run. */
export interface TraceEvent {
  ts: number;
  type: string;
  data?: JsonValue;
}

/**
 * Sink for the execution trace. The loop emits one event per meaningful step;
 * hosts write them to JSONL, a database, or a live UI.
 */
export interface Tracer {
  emit(type: string, data?: JsonValue): void;
}

/** In-memory tracer for tests and introspection. */
export class MemoryTracer implements Tracer {
  readonly events: TraceEvent[] = [];

  emit(type: string, data?: JsonValue): void {
    this.events.push({ ts: Date.now(), type, ...(data !== undefined ? { data } : {}) });
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }

  find(type: string): TraceEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}
