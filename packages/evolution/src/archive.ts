import type { Signal } from "@mentat/core";
import { scoreOf, validateSignals } from "./pareto";
import type { Candidate, IterationRecord } from "./types";

export interface ArchivedCandidate extends Candidate {
  signals: Signal[];
  children: number;
  /**
   * Behavioural descriptor (task family, change type, engine, ...). Niche-aware
   * selection keeps open-ended search from collapsing onto one high-scoring
   * lineage.
   */
  niche?: string;
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

  add(
    candidate: Candidate,
    meta: { parentId?: string; signals: Signal[]; niche?: string },
  ): ArchivedCandidate {
    if (this.entries.has(candidate.id)) throw new Error("duplicate archived candidate identity");
    validateSignals(meta.signals);
    const entry: ArchivedCandidate = {
      id: candidate.id,
      version: candidate.version,
      artifacts: [...candidate.artifacts],
      signals: structuredClone(meta.signals),
      children: 0,
      ...(meta.parentId ? { parentId: meta.parentId } : {}),
      ...(meta.niche ? { niche: meta.niche } : {}),
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
   * Sample a parent. Niches are sampled uniformly first, then members within a
   * niche are weighted by score and inversely by how many children they have.
   * This preserves diversity while still favouring strong, under-explored
   * lineages. With a single niche the behaviour matches plain DGM selection.
   */
  selectParent(): ArchivedCandidate | undefined {
    const pool = this.list();
    if (pool.length === 0) return undefined;

    const niches = new Map<string, ArchivedCandidate[]>();
    for (const entry of pool) {
      const key = entry.niche ?? "_";
      const group = niches.get(key);
      if (group) group.push(entry);
      else niches.set(key, [entry]);
    }
    const groups = [...niches.values()];
    const group = groups[Math.floor(this.random() * groups.length)] ?? pool;

    const weights = group.map((entry) => {
      const score = scoreOf(entry.signals);
      return Math.max(score, 0.0001) / (1 + entry.children);
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let threshold = this.random() * total;
    for (let i = 0; i < group.length; i += 1) {
      threshold -= weights[i] ?? 0;
      if (threshold <= 0) {
        const entry = group[i];
        if (entry) return entry;
      }
    }
    return group[group.length - 1];
  }
}
