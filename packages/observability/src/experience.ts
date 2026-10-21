import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExperienceRecord } from "@mentat/session";
import { withFileLock } from "@mentat/storage-file";
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
  constructor(
    private readonly dir: string,
    private readonly options: {
      onDiagnostic?: (record: { code: string; message: string }) => void;
    } = {},
  ) {}

  private records(path: string, repair = false): ExperienceRecord[] {
    const text = readFileSync(path, "utf8"),
      lines = text.split("\n");
    const records: ExperienceRecord[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as ExperienceRecord);
      } catch (error) {
        if (index !== lines.length - 1 || text.endsWith("\n"))
          throw new Error(`corrupt experience record in ${path}`, { cause: error });
        this.options.onDiagnostic?.({ code: "EXPERIENCE_TORN_TAIL", message: path });
        if (repair) {
          writeFileSync(`${path}.${crypto.randomUUID()}.torn`, line, {
            flag: "wx",
            mode: 0o600,
            flush: true,
          });
          truncateSync(path, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
        }
      }
    }
    return records;
  }

  append(record: ExperienceRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${dayStamp(record.ts)}.jsonl`);
    withFileLock(`${path}.lock`, () => {
      let incomplete = false;
      if (existsSync(path)) {
        const fd = openSync(path, "r");
        try {
          const size = fstatSync(fd).size;
          if (size) {
            const last = Buffer.alloc(1);
            readSync(fd, last, 0, 1, size - 1);
            incomplete = last[0] !== 10;
          }
        } finally {
          closeSync(fd);
        }
      }
      if (incomplete) {
        this.records(path, true);
        const text = readFileSync(path, "utf8");
        if (text && !text.endsWith("\n")) appendFileSync(path, "\n");
      }
      appendFileSync(path, `${JSON.stringify(redact(record))}\n`, { mode: 0o600, flush: true });
    });
  }

  list(): ExperienceRecord[] {
    if (!existsSync(this.dir)) return [];
    const records: ExperienceRecord[] = [];
    const feedbackByTrace = new Map<string, Record<string, unknown>[]>();
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      for (const record of this.records(join(this.dir, name))) {
        try {
          if (
            record.trajectoryDir &&
            record.turnId &&
            existsSync(join(record.trajectoryDir, "events.jsonl"))
          ) {
            const trajectoryDir = record.trajectoryDir;
            let feedback = feedbackByTrace.get(trajectoryDir);
            if (!feedback) {
              feedback = readTrajectory(trajectoryDir)
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
              feedbackByTrace.set(trajectoryDir, feedback);
            }
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
