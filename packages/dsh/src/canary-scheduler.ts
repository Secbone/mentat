import type { CanaryAssessment } from "./canary-monitor";
import { defaultTimerScheduler, type TimerScheduler } from "./scheduler";

export interface CanaryTarget {
  enforce(): CanaryAssessment & { rolledBack: boolean };
}

export interface CanarySchedulerOptions {
  monitor: CanaryTarget;
  intervalMs: number;
  onRollback?: (assessment: CanaryAssessment & { rolledBack: true }) => void;
  onError?: (error: unknown) => void;
  scheduler?: TimerScheduler;
  now?: () => Date;
}

export interface CanaryHealth {
  active: boolean;
  lastCheckAt?: string;
  lastRollback?: boolean;
  lastReason?: string;
  lastError?: string;
  consecutiveFailures: number;
}

/** Periodic canary health check; a rollback clears the canary pack. */
export class CanaryScheduler {
  private readonly monitor: CanaryTarget;
  private readonly intervalMs: number;
  private readonly onRollback?: (assessment: CanaryAssessment & { rolledBack: true }) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly scheduler: TimerScheduler;
  private readonly clock: () => Date;
  private handle: unknown;
  private running = false;
  private busy = false;
  private lastCheckAt?: string;
  private lastRollback?: boolean;
  private lastReason?: string;
  private lastError?: string;
  private failures = 0;

  constructor(options: CanarySchedulerOptions) {
    this.monitor = options.monitor;
    this.intervalMs = options.intervalMs;
    if (options.onRollback) this.onRollback = options.onRollback;
    if (options.onError) this.onError = options.onError;
    this.scheduler = options.scheduler ?? defaultTimerScheduler;
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

  health(): CanaryHealth {
    return {
      active: this.running,
      ...(this.lastCheckAt ? { lastCheckAt: this.lastCheckAt } : {}),
      ...(this.lastRollback !== undefined ? { lastRollback: this.lastRollback } : {}),
      ...(this.lastReason ? { lastReason: this.lastReason } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      consecutiveFailures: this.failures,
    };
  }

  async tick(): Promise<(CanaryAssessment & { rolledBack: boolean }) | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    this.lastCheckAt = this.clock().toISOString();
    try {
      const assessment = this.monitor.enforce();
      this.lastRollback = assessment.rolledBack;
      this.lastReason = assessment.reason;
      this.lastError = undefined;
      this.failures = 0;
      if (assessment.rolledBack)
        this.onRollback?.(assessment as CanaryAssessment & { rolledBack: true });
      return assessment;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.failures += 1;
      this.onError?.(error);
      return undefined;
    } finally {
      this.busy = false;
    }
  }
}
