import type { JsonValue, Tracer } from "@mentat/core";

export interface TraceContext {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  turnId?: string;
  sessionId?: string;
}
export interface TrajectoryEvent extends TraceContext {
  schemaVersion: 1;
  eventId: string;
  seq: number;
  ts: number;
  type: string;
  data?: JsonValue;
}
export interface TrajectoryStore extends Tracer {
  readonly traceId: string;
  append(events: readonly TrajectoryEvent[]): Promise<void>;
  flush(): Promise<void>;
  read(): AsyncIterable<TrajectoryEvent>;
}
export interface ExperienceSink {
  append(record: import("./experience").ExperienceRecord): void;
}
export interface Diagnostic {
  code: string;
  message: string;
}
export function observe(
  tracer: Tracer | undefined,
  type: string,
  data?: JsonValue,
  diagnostic?: (d: Diagnostic) => void,
): void {
  try {
    tracer?.emit(type, data);
  } catch (error) {
    diagnostic?.({ code: "OBSERVABILITY_WRITE", message: String(error) });
  }
}
