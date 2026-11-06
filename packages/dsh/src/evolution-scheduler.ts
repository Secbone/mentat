import type { EvolutionOutcome } from "./evolver";
import { defaultTimerScheduler, type TimerScheduler } from "./scheduler";

export interface EvolutionTarget {
  evolve(): Promise<EvolutionOutcome>;
}

export interface EvolutionSchedulerOptions {
  evolver: EvolutionTarget;
  intervalMs: number;
  onResult?: (outcome: EvolutionOutcome) => void;
  onError?: (error: unknown) => void;
  scheduler?: TimerScheduler;
  now?: () => Date;
}

export interface EvolutionHealth {
  active: boolean;
  lastRunAt?: string;
  lastObservations?: number;
  lastAccepted?: boolean;
  lastError?: string;
  consecutiveFailures: number;
}

/**
 * Periodic Observe → Dream pass. A failed pass is reported and does not stop
 * the next one; overlapping ticks are skipped while a pass is still running.
 */
export class EvolutionScheduler {
  private readonly evolver: EvolutionTarget;
  private readonly intervalMs: number;
  private readonly onResult?: (outcome: EvolutionOutcome) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly scheduler: TimerScheduler;
  private readonly clock: () => Date;
  private handle: unknown;
  private running = false;
  private busy = false;
  private lastRunAt?: string;
  private lastObservations?: number;
  private lastAccepted?: boolean;
  private lastError?: string;
  private failures = 0;

  constructor(options: EvolutionSchedulerOptions) {
    this.evolver = options.evolver;
    this.intervalMs = options.intervalMs;
    if (options.onResult) this.onResult = options.onResult;
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

  health(): EvolutionHealth {
    return {
      active: this.running,
      ...(this.lastRunAt ? { lastRunAt: this.lastRunAt } : {}),
      ...(this.lastObservations !== undefined ? { lastObservations: this.lastObservations } : {}),
      ...(this.lastAccepted !== undefined ? { lastAccepted: this.lastAccepted } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      consecutiveFailures: this.failures,
    };
  }

  async tick(): Promise<EvolutionOutcome | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    this.lastRunAt = this.clock().toISOString();
    try {
      const outcome = await this.evolver.evolve();
      this.lastObservations = outcome.observations.length;
      this.lastAccepted = outcome.result?.accepted;
      this.lastError = undefined;
      this.failures = 0;
      if (outcome.result) this.onResult?.(outcome);
      return outcome;
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
