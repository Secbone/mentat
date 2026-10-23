import type {
  AgentEvent,
  JsonValue,
  RunCompletion,
  RunTermination,
  StopReason,
  TaskAcceptance,
  Usage,
} from "@mentat/core";
import { type EvidenceFragment, inputFragments, type TaskInput } from "./input";
export type RecordedToolCall =
  | {
      kind: "call";
      id: string;
      name: string;
      input: JsonValue;
      status?: string;
    }
  | {
      kind: "result";
      id: string;
      output: string;
      isError: boolean;
      content?: JsonValue;
      outputCoverage?: "complete" | "partial" | "unsupported";
    };

/** Message-level pointer inside a trajectory: who said what, and where. */
export interface MessageEvidence {
  role: "assistant" | "user" | "system" | "tool" | "document";
  index?: number;
  text: string;
  /** Absent in legacy records; do not infer source boundaries inside old mixed prompts. */
  fragments?: EvidenceFragment[];
}

/** One finished task's trajectory summary; the fuel for offline evolution. */
export interface ExperienceRecord {
  /** Host-owned user/project boundary for native interaction recall. */
  scope?: string;
  id: string;
  /** Imported observations preserve their date/roles; they are not verified task outcomes. */
  imported?: { source: string; sessionId: string; timestampKnown?: boolean; order?: number };
  traceId?: string;
  turnId?: string;
  trajectoryDir?: string;
  feedback?: Array<{ source: string; score?: number; accepted?: boolean; correction?: string }>;
  ts: number;
  prompt: string;
  cwd: string;
  harness: string;
  model?: string;
  outcome: StopReason;
  termination?: RunTermination;
  completion?: RunCompletion;
  acceptance?: TaskAcceptance;
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
  /** Permission lifecycle, including cancellation and handler errors. */
  permissions?: Extract<AgentEvent, { type: "permission.request" | "permission.resolved" }>[];
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
  scope?: string;
  prompt: string;
  input?: TaskInput;
  cwd: string;
  harness: string;
  model?: string;
}

/** Accumulates an {@link ExperienceRecord} from the normalized event stream. */
export class SessionRecorder {
  private readonly record: ExperienceRecord;

  constructor(base: ExperienceBase) {
    this.record = {
      id: `exp-${crypto.randomUUID()}`,
      ts: Date.now(),
      prompt: base.prompt,
      cwd: base.cwd,
      ...(base.scope !== undefined ? { scope: base.scope } : {}),
      harness: base.harness,
      ...(base.model ? { model: base.model } : {}),
      outcome: "error",
      toolErrors: 0,
      tools: [],
      messages: [
        {
          role: "user",
          index: 0,
          text: base.prompt,
          ...(base.input ? { fragments: inputFragments(base.input) } : {}),
        },
      ],
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
        if (event.termination) this.record.termination = structuredClone(event.termination);
        if (event.completion) this.record.completion = structuredClone(event.completion);
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
          ...(event.content !== undefined ? { content: structuredClone(event.content) } : {}),
          ...(event.outputCoverage ? { outputCoverage: event.outputCoverage } : {}),
        });
        break;
      case "tool.update": {
        const call = this.record.toolCalls?.findLast(
          (item) => item.kind === "call" && item.id === event.id,
        );
        if (call?.kind === "call") {
          if (event.input !== undefined) call.input = structuredClone(event.input);
          if (event.name !== undefined) {
            call.name = event.name;
            if (!this.record.tools.includes(event.name)) this.record.tools.push(event.name);
          }
          if (event.status !== undefined) call.status = event.status;
        }
        break;
      }
      case "permission.request":
      case "permission.resolved":
        this.record.permissions ??= [];
        this.record.permissions.push(structuredClone(event));
        break;
      default:
        break;
    }
  }

  snapshot(): ExperienceRecord {
    return structuredClone(this.record);
  }
}
