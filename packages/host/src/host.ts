import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assemblePrompt,
  assistantPromptOptions,
  type ReflectionInput,
  reflectMemories,
  rememberUserFact,
  saveReflections,
} from "@mentat/assistant";
import type {
  HarnessAdapter,
  JsonValue,
  PermissionHandler,
  SessionHandle,
  Tracer,
} from "@mentat/core";
import { createMemoryAccess, type MemoryAccess } from "@mentat/memory";
import { FileMemoryRepository } from "@mentat/memory-file";
import { memoryMcpSpec } from "@mentat/memory-mcp";
import { ExperienceStore, FileTrajectoryStore, projectExperience } from "@mentat/observability";
import {
  closeSession,
  type ExperienceSink,
  openSession,
  runTurn,
  SessionRecorder,
  type TurnOptions,
} from "@mentat/session";

export interface HostConfig {
  cwd: string;
  adapter: HarnessAdapter;
  reflectionAdapter?: HarnessAdapter;
  model?: string;
  memoryPath?: string;
  experienceDir?: string;
  logDir?: string;
  scope?: string;
  permission?: PermissionHandler;
  permissionMode?: string;
  protocolLog?: boolean;
  timeoutMs?: number;
}
export interface HostOverrides {
  memory?: MemoryAccess;
  experience?: ExperienceSink;
  trajectory?: Tracer;
  onDiagnostic?: TurnOptions["onDiagnostic"];
}
export function createAssistantHost(config: HostConfig, overrides: HostOverrides = {}) {
  if (!overrides.memory && !config.memoryPath)
    throw new Error("memory implementation or memoryPath required");
  config = {
    ...config,
    cwd: resolve(config.cwd),
    ...(config.memoryPath ? { memoryPath: resolve(config.memoryPath) } : {}),
  };
  const traceId = randomUUID();
  const diagnostic =
    overrides.onDiagnostic ??
    ((d) => {
      process.stderr.write(`[${d.code}] ${d.message}\n`);
    });
  let revision = "unknown";
  let dirty: boolean | null = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: config.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    dirty = Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: config.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {}
  const file = overrides.trajectory
    ? undefined
    : new FileTrajectoryStore(
        join(config.logDir ?? join(config.cwd, ".mentat", "runs"), traceId),
        {
          metadata: {
            cwd: config.cwd,
            revision,
            dirty,
            harness: config.adapter.id,
            model: config.model ?? null,
            permissionMode: config.permissionMode ?? "custom",
            protocolLog: config.protocolLog ?? false,
            promptVersion: "personal-assistant-v2",
          },
        },
        traceId,
      );
  const tracer = overrides.trajectory ?? file;
  if (!tracer) throw new Error("trajectory implementation required");
  const emit = (type: string, data: unknown) => {
    try {
      tracer.emit(type, data as JsonValue);
    } catch (error) {
      diagnostic({ code: "OBSERVABILITY_WRITE", message: String(error) });
    }
  };
  const fragmentOffsets = new Map<string, number>();
  const ingest = () => {
    if (!file) return;
    const dir = join(file.dir, "fragments");
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
  const memory =
    overrides.memory ??
    (config.memoryPath
      ? createMemoryAccess(new FileMemoryRepository(config.memoryPath), {
          scope: config.scope,
          observe: emit,
          onObserverError: (error) =>
            diagnostic({ code: "MEMORY_OBSERVER_FAILED", message: String(error) }),
        })
      : undefined);
  if (!memory) throw new Error("memory implementation or memoryPath required");
  const experience =
    overrides.experience ??
    new ExperienceStore(config.experienceDir ?? join(config.cwd, ".mentat", "experience"));
  const sessions = new Set<SessionHandle>();
  const sessionSpans = new WeakMap<SessionHandle, string>();
  const knownTurns = new Set<string>();
  let closed = false;
  emit("task.start", {
    traceId,
    revision,
    dirty,
    harness: config.adapter.id,
    capabilities: config.adapter.capabilities(),
  });
  const adapterDeps = {
    onDiagnostic: (record: { code: string; message: string }) => emit("adapter.diagnostic", record),
    ...(config.protocolLog
      ? {
          onProtocol: (record: { direction: "in" | "out"; data: unknown }) =>
            emit("adapter.protocol", record),
        }
      : {}),
  };
  const execution = (options: TurnOptions = {}): TurnOptions => ({
    ...options,
    tracer,
    onDiagnostic: diagnostic,
  });
  return {
    traceId,
    logDir: file?.dir,
    memory,
    async open() {
      if (closed) throw new Error("host is closed");
      const sessionSpan = crypto.randomUUID();
      emit("session.create.start", { harness: config.adapter.id, spanId: sessionSpan });
      try {
        const session = await openSession(
          config.adapter,
          {
            cwd: config.cwd,
            ...(config.model ? { model: config.model } : {}),
            ...assistantPromptOptions(config.adapter),
            ...(config.memoryPath
              ? {
                  mcpServers: [
                    memoryMcpSpec(
                      config.memoryPath,
                      config.scope,
                      file ? { traceId, dir: file.dir } : undefined,
                    ),
                  ],
                }
              : {}),
          },
          { ...adapterDeps, onPermission: config.permission },
          { timeoutMs: config.timeoutMs, onDiagnostic: diagnostic },
        );
        sessions.add(session);
        sessionSpans.set(session, sessionSpan);
        emit("session.create.end", { sessionId: session.id, spanId: sessionSpan });
        return session;
      } catch (error) {
        emit("session.create.error", { error: String(error) });
        throw error;
      }
    },
    async turn(session: SessionHandle, task: string, options: TurnOptions = {}) {
      if (closed || !sessions.has(session))
        throw new Error("session is not owned by an active host");
      let began = false;
      const turnId = options.turnId ?? randomUUID();
      knownTurns.add(turnId);
      const recorder = new SessionRecorder({
        prompt: task,
        cwd: config.cwd,
        harness: config.adapter.id,
        ...(config.model ? { model: config.model } : {}),
      });
      try {
        const assembled = await assemblePrompt(memory, config.adapter, task);
        emit("prompt.assembled", {
          turnId,
          parentSpanId: sessionSpans.get(session),
          sessionId: session.id,
          ...assembled.assembly,
        });
        if (assembled.blocked)
          throw new Error(
            `context budget cannot fit required constraints: ${assembled.assembly.selection.omittedRequiredIds.join(", ")}`,
          );
        began = true;
        const result = await runTurn(
          session,
          assembled.input,
          execution({
            ...options,
            turnId,
            parentSpanId: sessionSpans.get(session),
            onEvent: (event) => {
              recorder.handle(event);
              options.onEvent?.(event);
            },
          }),
        );
        ingest();
        try {
          await file?.flush();
        } catch (error) {
          diagnostic({ code: "TRAJECTORY_FLUSH_FAILED", message: String(error) });
        }
        let record = recorder.snapshot();
        if (file)
          try {
            record = projectExperience(
              file.dir,
              {
                prompt: task,
                cwd: config.cwd,
                harness: config.adapter.id,
                ...(config.model ? { model: config.model } : {}),
              },
              turnId,
            );
          } catch (error) {
            diagnostic({ code: "EXPERIENCE_PROJECTION_FAILED", message: String(error) });
          }
        let saved = false;
        try {
          experience.append(record);
          saved = true;
        } catch (error) {
          diagnostic({ code: "EXPERIENCE_WRITE_FAILED", message: String(error) });
          emit("experience.error", { turnId, error: String(error) });
        }
        if (saved) emit("experience.saved", { turnId, evidenceId: record.id });
        return { result, record };
      } catch (error) {
        if (!began)
          emit("turn.end", {
            turnId,
            sessionId: session.id,
            reason: "error",
            error: String(error),
            durationMs: 0,
            dispatched: false,
          });
        recorder.handle({
          type: "run.settled",
          sessionId: session.id,
          reason: "error",
          error: String(error),
        });
        experience.append(recorder.snapshot());
        emit("task.turn.error", { turnId, sessionId: session.id, error: String(error) });
        throw error;
      }
    },
    async remember(text: string) {
      const result = await rememberUserFact(memory, experience, text, config.cwd);
      emit("memory.confirm", { result });
      return result;
    },
    async reflect(input: ReflectionInput, options: TurnOptions = {}) {
      const spanId = randomUUID();
      emit("reflection.start", { spanId, evidence: input.interactions?.map((r) => r.id) });
      try {
        const parsed = await reflectMemories(config.reflectionAdapter ?? config.adapter, {
          ...input,
          cwd: config.cwd,
          ...(config.model ? { model: config.model } : {}),
          execution: { ...execution({ ...options, turnId: spanId }), deps: adapterDeps },
        });
        emit("reflection.parsed", { spanId, ...parsed });
        const added =
          parsed.status === "invalid" ? 0 : await saveReflections(memory, parsed.candidates);
        emit("reflection.end", { spanId, status: parsed.status, added });
        return { ...parsed, added };
      } catch (error) {
        emit("reflection.error", { spanId, error: String(error) });
        throw error;
      }
    },
    feedback(data: { turnId: string; accepted?: boolean; correction?: string; score?: number }) {
      if (!knownTurns.has(data.turnId)) throw new Error("feedback refers to an unknown turn");
      if (
        data.score !== undefined &&
        (!Number.isFinite(data.score) || data.score < 0 || data.score > 1)
      )
        throw new Error("feedback score must be 0..1");
      emit("task.feedback", { ...data, source: "host" });
    },
    async release(session: SessionHandle) {
      if (!sessions.delete(session)) return;
      try {
        await closeSession(session);
        emit("session.dispose", { sessionId: session.id });
      } catch (error) {
        emit("session.dispose.error", { sessionId: session.id, error: String(error) });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions) {
        try {
          await closeSession(session);
        } catch (error) {
          emit("session.dispose.error", { sessionId: session.id, error: String(error) });
        }
      }
      sessions.clear();
      ingest();
      emit("task.end", { traceId });
      try {
        await file?.close();
      } catch (error) {
        diagnostic({ code: "TRAJECTORY_CLOSE_FAILED", message: String(error) });
      }
    },
  };
}
