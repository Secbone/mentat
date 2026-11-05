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
  private handle: unknown;
  private running = false;

  constructor(options: SourcePollerOptions) {
    this.source = options.source;
    this.runtime = options.runtime;
    this.intervalMs = options.intervalMs;
    if (options.onError) this.onError = options.onError;
    this.scheduler = options.scheduler ?? defaultScheduler;
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

  async tick(): Promise<number> {
    try {
      return await this.runtime.pollSource(this.source);
    } catch (error) {
      this.onError?.(error);
      return 0;
    }
  }
}
