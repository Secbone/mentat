import type { Signal } from "@mentat/core";
import { scoreOf, validateSignals } from "./pareto";
import type { Candidate, IterationRecord } from "./types";

export interface ArchivedCandidate extends Candidate {
  signals: Signal[];
  children: number;
}

export type RandomFn = () => number;

/**
 * DGM-style archive: keeps every variant (not just the best) with its lineage,
 * so future iterations can branch off earlier "stepping stones".
 */
export class Archive {
  private readonly entries = new Map<string, ArchivedCandidate>();
  private readonly records: IterationRecord[] = [];
  private readonly order: string[] = [];
  private readonly random: RandomFn;

  constructor(random: RandomFn = Math.random) {
    this.random = random;
  }

  add(candidate: Candidate, meta: { parentId?: string; signals: Signal[] }): ArchivedCandidate {
    if (this.entries.has(candidate.id)) throw new Error("duplicate archived candidate identity");
    validateSignals(meta.signals);
    const entry: ArchivedCandidate = {
      id: candidate.id,
      version: candidate.version,
      artifacts: [...candidate.artifacts],
      signals: structuredClone(meta.signals),
      children: 0,
      ...(meta.parentId ? { parentId: meta.parentId } : {}),
    };
    this.entries.set(entry.id, entry);
    this.order.push(entry.id);
    if (meta.parentId) {
      const parent = this.entries.get(meta.parentId);
      if (parent) parent.children += 1;
    }
    return entry;
  }

  record(record: IterationRecord): void {
    this.records.push(record);
  }

  history(): IterationRecord[] {
    return [...this.records];
  }

  get(id: string): ArchivedCandidate | undefined {
    return this.entries.get(id);
  }

  list(): ArchivedCandidate[] {
    return this.order
      .map((id) => this.entries.get(id))
      .filter((entry): entry is ArchivedCandidate => entry !== undefined);
  }

  size(): number {
    return this.entries.size;
  }

  /** The best candidate by selection score (not used to accept changes). */
  best(): ArchivedCandidate | undefined {
    let best: ArchivedCandidate | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const entry of this.list()) {
      const score = scoreOf(entry.signals);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  }

  /**
   * Sample a parent: weight is proportional to score and inversely
   * proportional to how many children it already produced. This favors strong
   * but under-explored lineages (open-ended search).
   */
  selectParent(): ArchivedCandidate | undefined {
    const pool = this.list();
    if (pool.length === 0) return undefined;
    const weights = pool.map((entry) => {
      const score = scoreOf(entry.signals);
      return Math.max(score, 0.0001) / (1 + entry.children);
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let threshold = this.random() * total;
    for (let i = 0; i < pool.length; i += 1) {
      threshold -= weights[i] ?? 0;
      if (threshold <= 0) {
        const entry = pool[i];
        if (entry) return entry;
      }
    }
    return pool[pool.length - 1];
  }
}
