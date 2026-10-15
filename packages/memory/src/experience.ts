import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, JsonValue, StopReason, Usage } from "@mentat/core";

export type RecordedToolCall =
  | {
      kind: "call";
      id: string;
      name: string;
      input: JsonValue;
    }
  | {
      kind: "result";
      id: string;
      output: string;
      isError: boolean;
    };

/** Message-level pointer inside a trajectory: who said what, and where. */
export interface MessageEvidence {
  role: "assistant" | "user";
  index?: number;
  text: string;
}

/** One finished task's trajectory summary; the fuel for offline evolution. */
export interface ExperienceRecord {
  id: string;
  ts: number;
  prompt: string;
  cwd: string;
  harness: string;
  model?: string;
  outcome: StopReason;
  error?: string;
  usage?: Usage;
  toolErrors: number;
  tools: string[];
  /** Harness session id, when the adapter reported one. */
  sessionId?: string;
  /** Completed messages in order, so a memory's source can be pointed at. */
  messages?: MessageEvidence[];
  /** Observable tool inputs and results; no private reasoning. */
  toolCalls?: RecordedToolCall[];
}

/** Stable evidence pointer to a whole trajectory (message-level detail lives in it). */
export function experienceEvidence(record: ExperienceRecord): string {
  return `exp:${record.id}`;
}

/** Stable evidence pointer to one message within a trajectory. */
export function messageEvidence(record: ExperienceRecord, index: number): string {
  return `exp:${record.id}#msg${index}`;
}

/** Stable evidence pointer to a harness session (for interactive writes). */
export function sessionEvidence(sessionId: string): string {
  return `session:${sessionId}`;
}

export interface ExperienceBase {
  prompt: string;
  cwd: string;
  harness: string;
  model?: string;
}

let counter = 0;

/** Accumulates an {@link ExperienceRecord} from the normalized event stream. */
export class SessionRecorder {
  private readonly record: ExperienceRecord;

  constructor(base: ExperienceBase) {
    this.record = {
      id: `exp-${Date.now().toString(36)}-${(counter++).toString(36)}`,
      ts: Date.now(),
      prompt: base.prompt,
      cwd: base.cwd,
      harness: base.harness,
      ...(base.model ? { model: base.model } : {}),
      outcome: "error",
      toolErrors: 0,
      tools: [],
      messages: [{ role: "user", index: 0, text: base.prompt }],
      toolCalls: [],
    };
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "run.started":
        this.record.sessionId = event.sessionId;
        break;
      case "run.settled":
        this.record.outcome = event.reason;
        if (event.error) this.record.error = event.error;
        break;
      case "message.completed": {
        const messages = this.record.messages ?? [];
        messages.push({
          role: event.message.role,
          index: messages.length,
          text: event.message.text,
        });
        this.record.messages = messages;
        break;
      }
      case "usage":
        this.record.usage = event.usage;
        break;
      case "tool.start":
        if (!this.record.tools.includes(event.name)) this.record.tools.push(event.name);
        this.record.toolCalls?.push({
          kind: "call",
          id: event.id,
          name: event.name,
          input: structuredClone(event.input),
        });
        break;
      case "tool.result":
        if (event.isError) this.record.toolErrors += 1;
        this.record.toolCalls?.push({
          kind: "result",
          id: event.id,
          output: event.output,
          isError: event.isError,
        });
        break;
      default:
        break;
    }
  }

  snapshot(): ExperienceRecord {
    return structuredClone(this.record);
  }
}

function dayStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Append-only JSONL store of experience records, one file per day. */
export class ExperienceStore {
  constructor(private readonly dir: string) {}

  append(record: ExperienceRecord): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${dayStamp(record.ts)}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  list(): ExperienceRecord[] {
    if (!existsSync(this.dir)) return [];
    const records: ExperienceRecord[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as ExperienceRecord);
        } catch {
          /* skip a corrupt line */
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
