import type { SourceKind } from "@mentat/domain";

export interface PollTarget {
  pollSource(source: SourceKind): Promise<number>;
}

export interface PollScheduler {
  set(action: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}

export interface SourcePollerOptions {
  source: SourceKind;
  runtime: PollTarget;
  intervalMs: number;
  onError?: (error: unknown) => void;
  scheduler?: PollScheduler;
  now?: () => Date;
}

export interface PollerHealth {
  active: boolean;
  lastPollAt?: string;
  lastPollCount?: number;
  lastError?: string;
  consecutiveFailures: number;
}

const defaultScheduler: PollScheduler = {
  set: (action, intervalMs) => setInterval(action, intervalMs),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Periodic Source poll. The plugin owns the timer; a failed poll is reported
 * and does not stop the next one.
 */
export class SourcePoller {
  private readonly source: SourceKind;
  private readonly runtime: PollTarget;
  private readonly intervalMs: number;
  private readonly onError?: (error: unknown) => void;
  private readonly scheduler: PollScheduler;
  private readonly clock: () => Date;
  private handle: unknown;
  private running = false;
  private lastPollAt?: string;
  private lastPollCount?: number;
  private lastError?: string;
  private failures = 0;

  constructor(options: SourcePollerOptions) {
    this.source = options.source;
    this.runtime = options.runtime;
    this.intervalMs = options.intervalMs;
    if (options.onError) this.onError = options.onError;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clock = options.now ?? (() => new Date());
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.handle = this.scheduler.set(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.scheduler.clear(this.handle);
    this.handle = undefined;
  }

  health(): PollerHealth {
    return {
      active: this.running,
      ...(this.lastPollAt ? { lastPollAt: this.lastPollAt } : {}),
      ...(this.lastPollCount !== undefined ? { lastPollCount: this.lastPollCount } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      consecutiveFailures: this.failures,
    };
  }

  async tick(): Promise<number> {
    this.lastPollAt = this.clock().toISOString();
    try {
      const count = await this.runtime.pollSource(this.source);
      this.lastPollCount = count;
      this.lastError = undefined;
      this.failures = 0;
      return count;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.failures += 1;
      this.onError?.(error);
      return 0;
    }
  }
}
