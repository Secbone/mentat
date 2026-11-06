import type { DreamService, EvolutionResult, Observation, PackArchive } from "@mentat/evolve";
import type { CapabilityPack } from "@mentat/pack";
import type { ReceiptStore, RuntimeReceipt } from "./runtime";

export interface MentatEvolverOptions {
  receipts: ReceiptStore;
  packs: PackArchive;
  dream: DreamService;
  currentPack: () => CapabilityPack;
  /** Newest-first cap for one Dream pass; the proposer keeps its own limit. */
  maxObservations?: number;
}

export interface EvolutionOutcome {
  observations: Observation[];
  result?: EvolutionResult;
}

const FAILURE_KINDS = new Set(["failed", "blocked", "waiting", "dropped"]);

function observationOf(receipt: RuntimeReceipt): Observation | undefined {
  if (receipt.outcome !== "error" && !FAILURE_KINDS.has(receipt.report.kind)) return undefined;
  const detail = receipt.error ?? receipt.report.summary;
  return {
    id: `receipt:${receipt.assignment}`,
    at: receipt.at,
    text: `Worker ${receipt.worker} on ticket ${receipt.ticket} reported ${receipt.report.kind}: ${detail}`,
    kind: "failure",
    source: `receipt:${receipt.assignment}`,
  };
}

/**
 * Turn failed Assignment receipts into Dream observations. Receipts already
 * named by an archived candidate are skipped, so a periodic pass does not
 * re-learn the same lesson; duplicate lesson text is collapsed in one batch.
 */
export class MentatEvolver {
  private readonly receipts: ReceiptStore;
  private readonly packs: PackArchive;
  private readonly dream: DreamService;
  private readonly currentPack: () => CapabilityPack;
  private readonly maxObservations: number;

  constructor(options: MentatEvolverOptions) {
    this.receipts = options.receipts;
    this.packs = options.packs;
    this.dream = options.dream;
    this.currentPack = options.currentPack;
    this.maxObservations = options.maxObservations ?? 5;
  }

  observe(): Observation[] {
    const used = new Set(
      this.packs.list().flatMap((candidate) => candidate.provenance.observations),
    );
    const seen = new Set<string>();
    const rows: Observation[] = [];
    for (const receipt of this.receipts.list()) {
      const observation = observationOf(receipt);
      if (!observation || used.has(observation.id)) continue;
      const key = observation.text.replace(/\s+/g, " ").trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(observation);
    }
    return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, this.maxObservations);
  }

  async evolve(): Promise<EvolutionOutcome> {
    const observations = this.observe();
    if (observations.length === 0) return { observations };
    const result = await this.dream.dream(this.currentPack(), observations);
    return { observations, result };
  }
}
