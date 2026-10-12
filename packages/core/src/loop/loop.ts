import type { Signal } from "../artifact";
import type { Tracer } from "../trace";
import type { JsonValue } from "../types";
import { Archive } from "./archive";
import type { Evaluator } from "./evaluator";
import type { Gate } from "./gate";
import { dominates } from "./pareto";
import type { Proposer } from "./proposer";
import type { Candidate, IterationRecord, LoopConfig, Proposal } from "./types";
import type { Workspace } from "./workspace";

export interface LoopDeps {
  workspace: Workspace;
  proposer: Proposer;
  evaluator: Evaluator;
  gates?: Gate;
  archive?: Archive;
  config?: Partial<LoopConfig>;
  tracer?: Tracer;
  onIteration?: (record: IterationRecord) => void;
}

const signalsJson = (signals: Signal[]): JsonValue => signals as unknown as JsonValue;

const candidateJson = (candidate: Candidate): JsonValue => ({
  id: candidate.id,
  version: candidate.version,
  artifacts: candidate.artifacts.map((artifact) => artifact.id),
});

export interface LoopResult {
  best: Candidate;
  records: IterationRecord[];
  archive: Archive;
}

interface StepOutcome {
  record: IterationRecord;
  child?: Candidate;
  after?: Signal[];
}

function touchesProtected(parent: Candidate, proposal: Proposal): boolean {
  if (!proposal.artifacts) return false;
  const previous = new Map(parent.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifact of proposal.artifacts) {
    const prev = previous.get(artifact.id);
    if (prev?.protected && prev.version !== artifact.version) return true;
  }
  return false;
}

/**
 * The self-iteration loop: observe → propose → materialize → gate → evaluate →
 * select → archive. Deterministic when its dependencies are deterministic.
 */
export class SelfIterationLoop {
  private readonly workspace: Workspace;
  private readonly proposer: Proposer;
  private readonly evaluator: Evaluator;
  private readonly gates?: Gate;
  private readonly archive: Archive;
  private readonly config: LoopConfig;
  private readonly tracer?: Tracer;
  private readonly onIteration?: (record: IterationRecord) => void;

  constructor(deps: LoopDeps) {
    this.workspace = deps.workspace;
    this.proposer = deps.proposer;
    this.evaluator = deps.evaluator;
    if (deps.gates) this.gates = deps.gates;
    this.archive = deps.archive ?? new Archive();
    this.config = { maxIterations: 5, ...deps.config };
    if (deps.tracer) this.tracer = deps.tracer;
    if (deps.onIteration) this.onIteration = deps.onIteration;
  }

  private trace(type: string, data?: JsonValue): void {
    this.tracer?.emit(type, data);
  }

  async run(): Promise<LoopResult> {
    let current = this.workspace.current();
    let currentSignals = await this.evaluator.evaluate(current);
    this.archive.add(current, { signals: currentSignals });
    this.trace("loop.start", {
      root: candidateJson(current),
      maxIterations: this.config.maxIterations,
    });

    const records: IterationRecord[] = [];
    const maxFailures = this.config.maxFailures ?? Number.POSITIVE_INFINITY;
    let failures = 0;

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration += 1) {
      if (failures >= maxFailures) break;
      const outcome = await this.iterate(iteration, current, currentSignals);
      records.push(outcome.record);
      this.archive.record(outcome.record);
      this.onIteration?.(outcome.record);

      if (outcome.record.accepted && outcome.child && outcome.after) {
        current = outcome.child;
        currentSignals = outcome.after;
      } else {
        failures += 1;
      }
    }

    const best = this.archive.best() ?? current;
    this.trace("loop.end", { best: candidateJson(best), iterations: records.length });
    return { best, records, archive: this.archive };
  }

  private async iterate(
    iteration: number,
    parent: Candidate,
    before: Signal[],
  ): Promise<StepOutcome> {
    const proposal = await this.proposer.propose(parent, before);
    this.trace("iteration.propose", {
      iteration,
      parentId: parent.id,
      proposalId: proposal.id,
      description: proposal.description,
    });

    if (touchesProtected(parent, proposal)) {
      this.trace("iteration.gate", {
        iteration,
        passed: false,
        gate: "protected",
        reason: "protected artifact",
      });
      return {
        record: rejected(iteration, parent, proposal.id, proposal, before, "protected artifact"),
      };
    }

    let child: Candidate;
    try {
      child = await this.workspace.apply(proposal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.trace("iteration.apply", { iteration, failed: true, reason });
      return {
        record: rejected(
          iteration,
          parent,
          proposal.id,
          proposal,
          before,
          `apply failed: ${reason}`,
        ),
      };
    }
    this.trace("iteration.apply", { iteration, childId: child.id });

    const gate = this.gates ? await this.gates.check(child) : { passed: true, gate: "none" };
    this.trace("iteration.gate", {
      iteration,
      passed: gate.passed,
      gate: gate.gate,
      ...(gate.reason ? { reason: gate.reason } : {}),
    });
    if (!gate.passed) {
      await this.workspace.rollback(child);
      const record = rejected(
        iteration,
        parent,
        child.id,
        proposal,
        before,
        gate.reason ?? "gate rejected",
      );
      record.gate = gate;
      return { record, child };
    }

    const after = await this.evaluator.evaluate(child);
    this.archive.add(child, { parentId: parent.id, signals: after });

    const accepted = dominates(after, before);
    this.trace("iteration.select", {
      iteration,
      childId: child.id,
      accepted,
      before: signalsJson(before),
      after: signalsJson(after),
    });
    const record: IterationRecord = {
      iteration,
      parentId: parent.id,
      childId: child.id,
      proposal,
      gate,
      before,
      after,
      accepted,
      ...(accepted ? {} : { reason: "no improvement" }),
    };

    if (accepted) {
      await this.workspace.commit(child);
    } else {
      await this.workspace.rollback(child);
    }
    return { record, child, after };
  }
}

function rejected(
  iteration: number,
  parent: Candidate,
  childId: string,
  proposal: Proposal,
  before: Signal[],
  reason: string,
): IterationRecord {
  return { iteration, parentId: parent.id, childId, proposal, before, accepted: false, reason };
}
