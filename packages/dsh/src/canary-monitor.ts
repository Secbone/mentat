import type { PackChannel } from "@mentat/evolve";
import type { ReceiptStore, RuntimeReceipt } from "./runtime";

export interface CanaryPolicy {
  /** Minimum canary trials before any rollback decision. */
  minSamples: number;
  /** Absolute canary failure-rate ceiling. */
  maxFailureRate: number;
  /** Allowed canary failure rate above the stable baseline. */
  maxFailureRateDelta: number;
  /** Most recent trials per channel considered. */
  window: number;
}

export interface ChannelStats {
  total: number;
  completed: number;
  failed: number;
  failureRate: number | null;
}

export interface CanaryAssessment {
  rollback: boolean;
  reason?: string;
  canary: ChannelStats;
  stable: ChannelStats;
}

export interface CanaryMonitorOptions {
  receipts: ReceiptStore;
  channel: PackChannel;
  policy?: Partial<CanaryPolicy>;
  now?: () => Date;
}

const EMPTY: ChannelStats = { total: 0, completed: 0, failed: 0, failureRate: null };

function stats(rows: RuntimeReceipt[]): ChannelStats {
  const completed = rows.filter(
    (receipt) => receipt.outcome === "completed" && receipt.report.kind === "ready",
  ).length;
  return {
    total: rows.length,
    completed,
    failed: rows.length - completed,
    failureRate: rows.length > 0 ? (rows.length - completed) / rows.length : null,
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Compare canary receipts against the stable baseline. A canary is rolled back
 * when it exceeds the absolute failure ceiling or regresses beyond the allowed
 * delta; too few samples means no decision.
 */
export class CanaryMonitor {
  private readonly receipts: ReceiptStore;
  private readonly channel: PackChannel;
  private readonly policy: CanaryPolicy;

  constructor(options: CanaryMonitorOptions) {
    this.receipts = options.receipts;
    this.channel = options.channel;
    this.policy = {
      minSamples: options.policy?.minSamples ?? 5,
      maxFailureRate: options.policy?.maxFailureRate ?? 0.5,
      maxFailureRateDelta: options.policy?.maxFailureRateDelta ?? 0.2,
      window: options.policy?.window ?? 50,
    };
  }

  assess(): CanaryAssessment {
    const canaryPack = this.channel.canary();
    const stable = stats(this.rows("stable"));
    if (!canaryPack) return { rollback: false, reason: "no canary", canary: EMPTY, stable };

    const since = this.channel.canarySince();
    const canary = stats(this.rows("canary", since));
    if (canary.total < this.policy.minSamples)
      return {
        rollback: false,
        reason: `canary samples ${canary.total}/${this.policy.minSamples}`,
        canary,
        stable,
      };
    if (canary.failureRate !== null && canary.failureRate > this.policy.maxFailureRate)
      return {
        rollback: true,
        reason: `canary failure rate ${percent(canary.failureRate)} > ${percent(
          this.policy.maxFailureRate,
        )}`,
        canary,
        stable,
      };
    if (
      stable.total >= this.policy.minSamples &&
      canary.failureRate !== null &&
      stable.failureRate !== null &&
      canary.failureRate - stable.failureRate > this.policy.maxFailureRateDelta
    )
      return {
        rollback: true,
        reason: `canary failure rate ${percent(canary.failureRate)} exceeds stable ${percent(
          stable.failureRate,
        )} by more than ${percent(this.policy.maxFailureRateDelta)}`,
        canary,
        stable,
      };
    return { rollback: false, canary, stable };
  }

  enforce(): CanaryAssessment & { rolledBack: boolean } {
    const assessment = this.assess();
    if (!assessment.rollback) return { ...assessment, rolledBack: false };
    this.channel.rollback();
    return { ...assessment, rolledBack: true };
  }

  private rows(channel: "stable" | "canary", since?: string): RuntimeReceipt[] {
    return this.receipts
      .list()
      .filter((receipt) => (receipt.packChannel ?? "stable") === channel)
      .filter((receipt) => !since || receipt.at >= since)
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-this.policy.window);
  }
}
