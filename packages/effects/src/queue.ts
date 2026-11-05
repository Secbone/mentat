import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "@mentat/core";
import { atomicJson, withFileLock } from "@mentat/storage-file";

export type EffectStatus = "waiting" | "running" | "done" | "failed";

export interface EffectRecord {
  id: string;
  kind: string;
  /** Coalescing key: one waiting effect per kind/key. */
  key: string;
  payload: JsonValue;
  status: EffectStatus;
  attempts: number;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface EffectHealth {
  consecutiveFailures: number;
  lastError?: string;
}

export interface EffectHandlerContext {
  effect: EffectRecord;
  signal: AbortSignal;
}

export type EffectHandler = (payload: JsonValue, context: EffectHandlerContext) => Promise<void>;

export interface EffectQueueOptions {
  path: string;
  now?: () => Date;
  id?: () => string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Defer work without counting a failure. */
export class Later extends Error {}

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * Durable side-effect queue. A command enqueues work; the runtime runs it after
 * the state write. Waiting effects coalesce by kind+key, failures retry with
 * exponential backoff, and a third failure marks the kind unhealthy.
 */
export class EffectQueue {
  readonly path: string;
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly failures = new Map<string, number>();
  private readonly lastErrors = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private records: EffectRecord[];

  constructor(options: EffectQueueOptions) {
    this.path = options.path;
    this.clock = options.now ?? (() => new Date());
    this.nextId = options.id ?? (() => crypto.randomUUID());
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 2000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    mkdirSync(dirname(this.path), { recursive: true });
    this.records = this.load();
  }

  private load(): EffectRecord[] {
    if (!existsSync(this.path)) return [];
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("invalid effect queue: not an array");
    return raw as EffectRecord[];
  }

  private persist(): void {
    withFileLock(`${this.path}.lock`, () => atomicJson(this.path, this.records));
  }

  list(): EffectRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  pending(): EffectRecord[] {
    return this.records.filter(
      (record) => record.status === "waiting" || record.status === "running",
    );
  }

  idle(): boolean {
    return this.pending().length === 0;
  }

  health(): Record<string, EffectHealth> {
    const out: Record<string, EffectHealth> = {};
    for (const [kind, count] of this.failures) {
      out[kind] = {
        consecutiveFailures: count,
        ...(this.lastErrors.get(kind) ? { lastError: this.lastErrors.get(kind) } : {}),
      };
    }
    return out;
  }

  /** Enqueue once per kind+key while the earlier effect is still waiting. */
  enqueue(kind: string, key: string, payload: JsonValue): EffectRecord {
    const now = iso(this.clock());
    const existing = this.records.find(
      (record) => record.kind === kind && record.key === key && record.status === "waiting",
    );
    if (existing) {
      existing.payload = payload;
      existing.dueAt = now;
      existing.updatedAt = now;
      this.persist();
      return { ...existing };
    }
    const record: EffectRecord = {
      id: this.nextId(),
      kind,
      key,
      payload,
      status: "waiting",
      attempts: 0,
      dueAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    this.persist();
    return { ...record };
  }

  handle(kind: string, handler: EffectHandler): () => void {
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  /**
   * Run due effects once. Returns how many were attempted.
   * shortcut: sequential dispatch; per-kind concurrency lands with the runtime.
   */
  async runDue(): Promise<number> {
    const now = this.clock().getTime();
    const due = this.records
      .filter((record) => record.status === "waiting" && Date.parse(record.dueAt) <= now)
      .sort(
        (a, b) =>
          Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.createdAt.localeCompare(b.createdAt),
      );
    let attempted = 0;
    for (const record of due) {
      const handler = this.handlers.get(record.kind);
      if (!handler) continue;
      attempted += 1;
      record.status = "running";
      record.updatedAt = iso(this.clock());
      this.persist();
      const controller = new AbortController();
      try {
        await handler(record.payload, { effect: { ...record }, signal: controller.signal });
        record.status = "done";
        record.updatedAt = iso(this.clock());
        this.failures.set(record.kind, 0);
        this.lastErrors.delete(record.kind);
      } catch (error) {
        if (error instanceof Later) {
          record.status = "waiting";
          record.dueAt = iso(new Date(this.clock().getTime() + this.baseDelayMs));
          record.updatedAt = iso(this.clock());
        } else {
          record.attempts += 1;
          record.lastError = error instanceof Error ? error.message : String(error);
          this.failures.set(record.kind, (this.failures.get(record.kind) ?? 0) + 1);
          this.lastErrors.set(record.kind, record.lastError);
          if (record.attempts >= this.maxAttempts) {
            record.status = "failed";
          } else {
            const delay = Math.min(this.baseDelayMs * 2 ** (record.attempts - 1), this.maxDelayMs);
            record.status = "waiting";
            record.dueAt = iso(new Date(this.clock().getTime() + delay));
          }
          record.updatedAt = iso(this.clock());
        }
      }
      this.persist();
    }
    return attempted;
  }

  /** Start a periodic pass; the returned stop function drains nothing. */
  start(intervalMs = 1000): () => void {
    if (this.timer) return () => this.stop();
    this.timer = setInterval(() => void this.runDue(), intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
