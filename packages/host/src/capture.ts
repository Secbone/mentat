import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@mentat/core";

export function createFragmentIngestor(
  directory: string | undefined,
  traceId: string,
  emit: (type: string, data: unknown) => void,
) {
  const fragmentOffsets = new Map<string, number>();
  const ingest = () => {
    if (!directory) return;
    const dir = join(directory, "fragments");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
      const lines = readFileSync(join(dir, name), "utf8").split("\n");
      let offset = fragmentOffsets.get(name) ?? 0;
      for (; offset < lines.length - 1; offset++) {
        const line = lines[offset];
        if (!line) continue;
        try {
          const record = JSON.parse(line) as {
            traceId: string;
            eventId: string;
            type: string;
            data: JsonValue;
            sourceSeq: number;
            source: string;
            ts: number;
          };
          if (record.traceId !== traceId) throw new Error("fragment trace mismatch");
          emit(record.type, {
            source: record.source,
            sourceEventId: record.eventId,
            sourceSeq: record.sourceSeq,
            sourceTs: record.ts,
            record: record.data,
          });
        } catch (error) {
          emit("capture.gap", { fragment: name, line: offset, error: String(error) });
        }
      }
      fragmentOffsets.set(name, offset);
    }
  };
  return () => {
    try {
      ingest();
    } catch (error) {
      emit("capture.gap", { source: "fragment-ingest", error: String(error) });
    }
  };
}
