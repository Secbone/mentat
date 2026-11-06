import type { CapabilityPack } from "@mentat/pack";

export type PackChannelName = "stable" | "canary";

export interface PackSelection {
  pack: CapabilityPack;
  channel: PackChannelName;
}

export interface PackChannelSnapshot {
  stable: CapabilityPack;
  canary?: CapabilityPack;
  canaryRatio: number;
  previous: CapabilityPack[];
}

export interface PackChannelOptions {
  stable: CapabilityPack;
  canary?: CapabilityPack;
  canaryRatio?: number;
  previous?: CapabilityPack[];
  /** Deterministic [0, 1) bucket; defaults to FNV-1a over the assignment id. */
  bucket?: (assignmentId: string) => number;
  onChange?: (snapshot: PackChannelSnapshot) => void;
}

function defaultBucket(assignmentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < assignmentId.length; index++) {
    hash ^= assignmentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

const MAX_PREVIOUS = 20;

function ratio(value: number | undefined): number {
  const next = value ?? 0.1;
  if (!Number.isFinite(next) || next < 0 || next > 1)
    throw new Error("canary ratio must be between 0 and 1");
  return next;
}

/**
 * Stable/canary pack selection. Assignment ids map to a deterministic bucket,
 * so retries stay in the same channel and a ratio change is auditable.
 */
export class PackChannel {
  private stablePack: CapabilityPack;
  private canaryPack?: CapabilityPack;
  private canaryRatio: number;
  private previousPacks: CapabilityPack[];
  private readonly bucket: (assignmentId: string) => number;
  private readonly onChange?: (snapshot: PackChannelSnapshot) => void;

  constructor(options: PackChannelOptions) {
    this.stablePack = options.stable;
    if (options.canary) this.canaryPack = options.canary;
    this.canaryRatio = ratio(options.canaryRatio);
    this.previousPacks = [...(options.previous ?? [])];
    this.bucket = options.bucket ?? defaultBucket;
    if (options.onChange) this.onChange = options.onChange;
  }

  select(assignmentId: string): PackSelection {
    if (this.canaryPack && this.canaryRatio > 0 && this.bucket(assignmentId) < this.canaryRatio)
      return { pack: this.canaryPack, channel: "canary" };
    return { pack: this.stablePack, channel: "stable" };
  }

  current(): CapabilityPack {
    return this.stablePack;
  }

  canary(): CapabilityPack | undefined {
    return this.canaryPack;
  }

  ratio(): number {
    return this.canaryRatio;
  }

  setStable(pack: CapabilityPack): void {
    this.remember(this.stablePack);
    this.stablePack = pack;
    this.canaryPack = undefined;
    this.persist();
  }

  setCanary(pack: CapabilityPack, canaryRatio = 0.1): void {
    this.canaryPack = pack;
    this.canaryRatio = ratio(canaryRatio);
    this.persist();
  }

  clearCanary(): void {
    if (!this.canaryPack) return;
    this.canaryPack = undefined;
    this.persist();
  }

  /** Promote the canary to stable; the previous stable becomes the rollback target. */
  promote(): void {
    if (!this.canaryPack) throw new Error("no canary pack to promote");
    this.remember(this.stablePack);
    this.stablePack = this.canaryPack;
    this.canaryPack = undefined;
    this.persist();
  }

  /** Stop a canary first; otherwise revert the last promotion. */
  rollback(): void {
    if (this.canaryPack) {
      this.canaryPack = undefined;
      this.persist();
      return;
    }
    const previous = this.previousPacks.pop();
    if (!previous) throw new Error("no previous pack to roll back to");
    this.stablePack = previous;
    this.persist();
  }

  snapshot(): PackChannelSnapshot {
    return {
      stable: this.stablePack,
      ...(this.canaryPack ? { canary: this.canaryPack } : {}),
      canaryRatio: this.canaryRatio,
      previous: [...this.previousPacks],
    };
  }

  private remember(pack: CapabilityPack): void {
    this.previousPacks.push(pack);
    if (this.previousPacks.length > MAX_PREVIOUS) this.previousPacks.shift();
  }

  private persist(): void {
    this.onChange?.(this.snapshot());
  }
}
