import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExperienceRecord } from "@mentat/session";
import { readTrajectory, redact, resolveEventData } from "./trajectory";

export type {
  ExperienceBase,
  ExperienceRecord,
  MessageEvidence,
  RecordedToolCall,
} from "@mentat/session";
export {
  experienceEvidence,
  messageEvidence,
  SessionRecorder,
  sessionEvidence,
} from "@mentat/session";

function dayStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Append-only JSONL store of experience records, one file per day. */
export class ExperienceStore {
  constructor(private readonly dir: string) {}

  append(record: ExperienceRecord): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(
      join(this.dir, `${dayStamp(record.ts)}.jsonl`),
      `${JSON.stringify(redact(record))}\n`,
    );
  }

  list(): ExperienceRecord[] {
    if (!existsSync(this.dir)) return [];
    const records: ExperienceRecord[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as ExperienceRecord;
          if (
            record.trajectoryDir &&
            record.turnId &&
            existsSync(join(record.trajectoryDir, "events.jsonl"))
          ) {
            const trajectoryDir = record.trajectoryDir;
            const feedback = readTrajectory(trajectoryDir)
              .filter((e) => e.type === "task.feedback")
              .map((e) => resolveEventData(trajectoryDir, e) as Record<string, unknown>);
            const path = join(record.trajectoryDir, "feedback.jsonl");
            if (existsSync(path))
              feedback.push(
                ...readFileSync(path, "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map((value) => JSON.parse(value) as Record<string, unknown>),
              );
            record.feedback = feedback
              .filter((value) => value.turnId === record.turnId)
              .map((value) => ({
                source: String(value.source ?? "host"),
                ...(typeof value.score === "number" ? { score: value.score } : {}),
                ...(typeof value.accepted === "boolean" ? { accepted: value.accepted } : {}),
                ...(typeof value.correction === "string" ? { correction: value.correction } : {}),
              }));
          }
          records.push(record);
        } catch (error) {
          throw new Error(`corrupt experience record in ${name}`, { cause: error });
        }
      }
    }
    return records;
  }

  recent(limit: number): ExperienceRecord[] {
    const all = this.list();
    return all.slice(Math.max(0, all.length - limit));
  }
}
