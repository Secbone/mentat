import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { JsonValue } from "@mentat/core";
import {
  type ExperienceBase,
  normalizeTaskInput,
  SessionRecorder,
  type TrajectoryEvent,
  type TrajectoryStore,
} from "@mentat/session";

export { redact } from "@mentat/core";

import { redact } from "@mentat/core";
import { auditAcpCapture } from "./capture-audit";
export interface TrajectoryOptions {
  maxBytes?: number;
  artifactThreshold?: number;
  metadata?: JsonValue;
}
/** Single writer per trace, ordered append; flush is the durability barrier. */
export class FileTrajectoryStore implements TrajectoryStore {
  readonly traceId: string;
  private seq = 0;
  private bytes = 0;
  private fd: number;
  private closed = false;
  private limited = false;
  private failed = false;
  private readonly pendingArtifacts = new Set<string>();
  readonly dir: string;
  constructor(dir: string, options: TrajectoryOptions = {}, traceId: string = randomUUID()) {
    this.dir = resolve(dir);
    this.traceId = traceId;
    this.options = options;
    mkdirSync(join(this.dir, "artifacts"), { recursive: true, mode: 0o700 });
    this.fd = openSync(join(this.dir, "events.jsonl"), "wx", 0o600);
    this.manifest("running");
  }
  private readonly options: TrajectoryOptions;
  private manifest(status: string) {
    const tmp = join(this.dir, "manifest.tmp");
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          schemaVersion: 1,
          traceId: this.traceId,
          pid: process.pid,
          status,
          limited: this.limited,
          metadata: redact(this.options.metadata),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(tmp, join(this.dir, "manifest.json"));
  }

  private payload(data: JsonValue): JsonValue {
    const text = JSON.stringify(redact(data));
    if (text.length < (this.options.artifactThreshold ?? 4096))
      return JSON.parse(text) as JsonValue;
    const hash = createHash("sha256").update(text).digest("hex");
    const ref = `artifacts/${hash}.json`;
    writeFileSync(join(this.dir, ref), text, { mode: 0o600 });
    this.bytes += Buffer.byteLength(text);
    this.pendingArtifacts.add(join(this.dir, ref));
    return { artifact: ref, sha256: hash, bytes: Buffer.byteLength(text) };
  }
  emit(type: string, data?: JsonValue): void {
    try {
      this.capture(type, data);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  private capture(type: string, data?: JsonValue): void {
    if (this.closed) throw new Error("trajectory is closed");
    if (this.limited) return;
    if (
      this.bytes + Buffer.byteLength(JSON.stringify(data ?? null)) >
      (this.options.maxBytes ?? 256 * 1024 * 1024)
    ) {
      this.limited = true;
      const gap = {
        schemaVersion: 1,
        eventId: randomUUID(),
        traceId: this.traceId,
        seq: this.seq++,
        ts: Date.now(),
        type: "capture.gap",
        data: { reason: "capacity limit", droppedType: type },
      };
      writeFileSync(this.fd, `${JSON.stringify(gap)}\n`);
      this.manifest("incomplete");
      return;
    }
    const object = data && !Array.isArray(data) && typeof data === "object" ? data : {};
    const turnId = typeof object.turnId === "string" ? object.turnId : undefined;
    const spanId = typeof object.spanId === "string" ? object.spanId : turnId;
    const event: TrajectoryEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      traceId: this.traceId,
      seq: this.seq++,
      ts: Date.now(),
      type,
      ...(turnId ? { turnId } : {}),
      ...(spanId ? { spanId } : {}),
      ...(typeof object.parentSpanId === "string" ? { parentSpanId: object.parentSpanId } : {}),
      ...(typeof object.sessionId === "string" ? { sessionId: object.sessionId } : {}),
      ...(data !== undefined ? { data: this.payload(data) } : {}),
    };
    const line = `${JSON.stringify(event)}\n`;
    writeFileSync(this.fd, line);
    this.bytes += Buffer.byteLength(line);
  }
  async append(events: readonly TrajectoryEvent[]) {
    for (const event of events) {
      if (this.closed) throw new Error("trajectory is closed");
      if (event.schemaVersion !== 1 || event.traceId !== this.traceId || event.seq !== this.seq)
        throw new Error("trace identity or sequence mismatch");
      if (this.limited) break;
      if (
        this.bytes + Buffer.byteLength(JSON.stringify(event.data ?? null)) >
        (this.options.maxBytes ?? 256 * 1024 * 1024)
      ) {
        this.emit(event.type, event.data);
        continue;
      }
      const next = {
        ...event,
        ...(event.data === undefined ? {} : { data: this.payload(event.data) }),
      };
      const line = `${JSON.stringify(next)}\n`;
      writeFileSync(this.fd, line);
      this.bytes += Buffer.byteLength(line);
      this.seq++;
    }
  }
  async flush() {
    if (this.closed) return;
    for (const path of this.pendingArtifacts) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.pendingArtifacts.clear();
    const artifactDir = openSync(join(this.dir, "artifacts"), "r");
    try {
      fsyncSync(artifactDir);
    } finally {
      closeSync(artifactDir);
    }
    fsyncSync(this.fd);
  }

  async *read() {
    yield* readTrajectory(this.dir);
  }
  async close(status = "complete") {
    if (this.closed) return;
    try {
      await this.flush();
      this.manifest(this.limited || this.failed ? "incomplete" : status);
      writeFileSync(
        join(this.dir, "summary.json"),
        JSON.stringify(summarizeTrajectory(this.dir), null, 2),
        { mode: 0o600 },
      );
      for (const name of ["manifest.json", "summary.json"]) {
        const fd = openSync(join(this.dir, name), "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      const dir = openSync(this.dir, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      closeSync(this.fd);
      this.closed = true;
    }
  }
}
export function readTrajectory(dir: string): TrajectoryEvent[] {
  const text = readFileSync(join(dir, "events.jsonl"), "utf8");
  const events: TrajectoryEvent[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let event: TrajectoryEvent;
    try {
      event = JSON.parse(line) as TrajectoryEvent;
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        events.push({
          schemaVersion: 1,
          eventId: "torn-tail",
          traceId: events[0]?.traceId ?? "unknown",
          seq: events.length,
          ts: Date.now(),
          type: "capture.gap",
          data: { reason: "torn tail" },
        });
        break;
      }
      throw error;
    }
    if (event.schemaVersion !== 1 || event.seq !== events.length || typeof event.type !== "string")
      throw new Error(`invalid trajectory event at ${index}`);
    events.push(event);
  }
  return events;
}
export function resolveEventData(dir: string, event: TrajectoryEvent): JsonValue | undefined {
  const data = event.data;
  if (
    data &&
    !Array.isArray(data) &&
    typeof data === "object" &&
    typeof data.artifact === "string"
  ) {
    if (!/^artifacts\/[a-f0-9]{64}\.json$/.test(data.artifact))
      throw new Error("invalid artifact reference");
    const text = readFileSync(join(dir, data.artifact), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== data.sha256)
      throw new Error("artifact hash mismatch");
    return JSON.parse(text) as JsonValue;
  }
  return data;
}
export function projectExperience(dir: string, base: ExperienceBase, turnId: string) {
  const events = readTrajectory(dir);
  const source = events.find((event) => event.type === "task.input" && event.turnId === turnId);
  const data = source
    ? (resolveEventData(dir, source) as { input?: import("@mentat/session").TaskInput })
    : undefined;
  const input = data?.input ? normalizeTaskInput(data.input) : base.input;
  const recorder = new SessionRecorder({
    ...base,
    ...(input ? { prompt: input.text, input } : {}),
  });
  const saved = events.find(
    (event) => event.type === "experience.saved" && event.turnId === turnId,
  );
  const savedData = saved ? (resolveEventData(dir, saved) as { evidenceId?: string }) : undefined;
  for (const event of events)
    if (event.type === "agent.event" && event.turnId === turnId)
      recorder.handle(resolveEventData(dir, event) as unknown as import("@mentat/core").AgentEvent);
  return {
    ...recorder.snapshot(),
    ts:
      source?.ts ??
      events.find((event) => event.turnId === turnId && event.type === "turn.start")?.ts ??
      recorder.snapshot().ts,
    id:
      savedData?.evidenceId ??
      `exp-${createHash("sha256")
        .update(`${events[0]?.traceId ?? "unknown"}#${turnId}`)
        .digest("hex")
        .slice(0, 32)}`,
    traceId: events[0]?.traceId,
    turnId,
    trajectoryDir: dir,
  };
}
export function inspectTrajectory(dir: string) {
  const events = readTrajectory(dir);
  const violations: string[] = [];
  const turns = new Map<string, { ends: number; calls: Set<string> }>();
  const permissions = new Map<string, boolean>();
  let nonTextToolResults = 0;
  const selected = new Set<string>(),
    committed = new Set<string>();
  for (const event of events) {
    const data = resolveEventData(dir, event) as Record<string, JsonValue> | undefined;
    if (event.turnId) {
      const state = turns.get(event.turnId) ?? { ends: 0, calls: new Set<string>() };
      turns.set(event.turnId, state);
      if (event.type === "turn.end") state.ends++;
      if (event.type === "agent.event" && data?.type === "tool.start")
        state.calls.add(String(data.id));
      if (
        event.type === "agent.event" &&
        data?.type === "tool.result" &&
        !state.calls.has(String(data.id))
      )
        violations.push(`orphan tool result: ${data.id}`);
      if (
        event.type === "agent.event" &&
        data?.type === "tool.update" &&
        !state.calls.has(String(data.id))
      )
        violations.push(`orphan tool update: ${data.id}`);
    }
    if (event.type === "agent.event" && data?.type === "permission.request")
      permissions.set(`${data.sessionId}:${data.id}`, false);
    if (event.type === "agent.event" && data?.type === "permission.resolved") {
      const id = `${data.sessionId}:${data.id}`;
      if (!permissions.has(id)) violations.push(`orphan permission decision: ${data.id}`);
      else if (permissions.get(id)) violations.push(`duplicate permission decision: ${data.id}`);
      permissions.set(id, true);
    }
    if (
      event.type === "agent.event" &&
      data?.type === "tool.result" &&
      ["partial", "unsupported"].includes(String(data.outputCoverage))
    )
      nonTextToolResults++;
    if (event.type === "iteration.select" && data?.accepted === true)
      selected.add(String(data.childId));
    if (event.type === "workspace.commit.end") committed.add(String(data?.candidateId));
    if (event.type === "workspace.rollback.error") violations.push("rollback failed");
  }
  for (const candidate of selected)
    if (!committed.has(candidate))
      violations.push(`accepted candidate ${candidate} has no successful commit`);
  for (const [turn, state] of turns)
    if (state.ends !== 1) violations.push(`turn ${turn}: ${state.ends} terminal events`);
  for (const [id, resolved] of permissions)
    if (!resolved) violations.push(`unresolved permission: ${id}`);
  const capture = auditAcpCapture(
    events.map((event) => ({ type: event.type, data: resolveEventData(dir, event) })),
  );
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    status: string;
    pid?: number;
  };
  if (manifest.status === "running" && manifest.pid) {
    try {
      process.kill(manifest.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") manifest.status = "interrupted";
    }
  }
  return {
    traceId: events[0]?.traceId,
    status: manifest.status,
    events: events.length,
    turns: turns.size,
    gaps: events.filter((e) => e.type === "capture.gap").length,
    violations,
    capture: { ...capture, nonTextToolResults },
  };
}
/** Explicit maintenance; never runs while creating a trace or against running traces. */
export function pruneTrajectories(root: string, olderThan: number): string[] {
  const removed: string[] = [];
  if (!existsSync(root)) return removed;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { status: string };
    const events = readTrajectory(dir);
    if (
      manifest.status !== "running" &&
      events.length &&
      (events.at(-1)?.ts ?? Infinity) < olderThan
    ) {
      rmSync(dir, { recursive: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

export function summarizeTrajectory(dir: string) {
  const stats = inspectTrajectory(dir);
  const events = readTrajectory(dir);
  let toolCalls = 0,
    toolErrors = 0,
    durationMs = 0,
    inputTokens = 0,
    outputTokens = 0;
  let costUsd: number | null = null;
  const ends: Record<string, number> = {};
  const turns = new Map<string, { input: number; output: number; cost?: number }>();
  for (const event of events) {
    const data = resolveEventData(dir, event) as Record<string, unknown> | undefined;
    if (event.type === "turn.end") {
      const reason = String(data?.reason);
      ends[reason] = (ends[reason] ?? 0) + 1;
      durationMs += Number(data?.durationMs ?? 0);
    }
    if (event.type === "agent.event" && data?.type === "tool.start") toolCalls++;
    if (event.type === "agent.event" && data?.type === "tool.result" && data?.isError) toolErrors++;
    if (event.type === "agent.event" && data?.type === "usage") {
      const usage = data.usage as { inputTokens: number; outputTokens: number; costUsd?: number };
      turns.set(event.turnId ?? event.eventId, {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cost: usage.costUsd,
      });
    }
  }
  for (const usage of turns.values()) {
    inputTokens += usage.input;
    outputTokens += usage.output;
    if (usage.cost !== undefined) costUsd = (costUsd ?? 0) + usage.cost;
  }
  const feedbackPath = join(dir, "feedback.jsonl");
  const feedback: unknown[] = existsSync(feedbackPath)
    ? readFileSync(feedbackPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
    : [];
  feedback.push(
    ...events.filter((e) => e.type === "task.feedback").map((e) => resolveEventData(dir, e)),
  );
  return {
    ...stats,
    usageComplete: turns.size === stats.turns,
    costComplete:
      turns.size === stats.turns && [...turns.values()].every((u) => u.cost !== undefined),
    ends,
    toolCalls,
    toolErrors,
    durationMs,
    inputTokens,
    outputTokens,
    costUsd,
    feedback,
  };
}
