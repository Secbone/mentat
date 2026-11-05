import type { Signal } from "@mentat/core";
import { type CapabilityPack, packRef } from "@mentat/pack";
import { PackArchive } from "./archive";
import { improvementGate } from "./gate";
import type {
  GateResult,
  Observation,
  PackCandidate,
  PackEvaluator,
  PackGate,
  PackProposer,
} from "./types";

export interface EvolutionOptions {
  proposer: PackProposer;
  evaluator: PackEvaluator;
  gates?: PackGate;
  archive?: PackArchive;
  now?: () => Date;
  id?: () => string;
}

export interface EvolutionResult {
  candidate: PackCandidate;
  accepted: boolean;
  baseSignals: Signal[];
  candidateSignals: Signal[];
  gate: GateResult;
}

/**
 * Propose → evaluate → gate → archive. A candidate is accepted only when it
 * passes every gate; the default gate requires a Pareto improvement.
 */
export class EvolutionLoop {
  private readonly proposer: PackProposer;
  private readonly evaluator: PackEvaluator;
  private readonly gates: PackGate;
  private readonly archive: PackArchive;
  private readonly clock: () => Date;
  private readonly nextId: () => string;

  constructor(options: EvolutionOptions) {
    this.proposer = options.proposer;
    this.evaluator = options.evaluator;
    this.gates = options.gates ?? improvementGate();
    this.archive = options.archive ?? new PackArchive();
    this.clock = options.now ?? (() => new Date());
    this.nextId = options.id ?? (() => crypto.randomUUID());
  }

  async run(base: CapabilityPack, observations: Observation[]): Promise<EvolutionResult> {
    const baseSignals = await this.evaluator.evaluate(base);
    const pack = await this.proposer.propose(base, observations);
    const candidateSignals = await this.evaluator.evaluate(pack);
    const candidate: PackCandidate = {
      id: this.nextId(),
      at: this.clock().toISOString(),
      base: packRef(base),
      pack,
      status: "evaluated",
      provenance: {
        proposer: this.proposer.id ?? "proposer",
        observations: observations.map((observation) => observation.id),
        rationale: "proposed from observations",
      },
      signals: { base: baseSignals, candidate: candidateSignals },
    };
    const gate = await this.gates.check(candidate);
    candidate.gate = gate;
    candidate.status = gate.passed ? "accepted" : "rejected";
    if (!gate.passed) candidate.reason = gate.reason ?? "gate rejected";
    this.archive.add(candidate);
    return {
      candidate,
      accepted: gate.passed,
      baseSignals,
      candidateSignals,
      gate,
    };
  }
}

/** Dream is the offline entry point: observations in, one candidate out. */
export class DreamService {
  constructor(private readonly loop: EvolutionLoop) {}

  dream(base: CapabilityPack, observations: Observation[]): Promise<EvolutionResult> {
    return this.loop.run(base, observations);
  }
}
