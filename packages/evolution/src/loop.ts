import type { JsonValue, Signal, Tracer } from "@mentat/core";
import { Archive } from "./archive";
import type { Evaluator } from "./evaluator";
import type { Gate } from "./gate";
import { assertComparableSignals, dominates, validateSignals } from "./pareto";
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
  onDiagnostic?: (error: unknown) => void;
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
  for (const artifact of parent.artifacts.filter((item) => item.protected)) {
    const replacements = (proposal.artifacts ?? []).filter((item) => item.id === artifact.id);
    // Retain the trusted implementation itself, not model-supplied metadata or code.
    if (replacements.length !== 1 || replacements[0] !== artifact) return true;
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
  private readonly onDiagnostic?: (error: unknown) => void;

  constructor(deps: LoopDeps) {
    this.workspace = deps.workspace;
    this.proposer = deps.proposer;
    this.evaluator = deps.evaluator;
    if (deps.gates) this.gates = deps.gates;
    this.archive = deps.archive ?? new Archive();
    this.config = { maxIterations: 5, ...deps.config };
    if (
      !Number.isSafeInteger(this.config.maxIterations) ||
      this.config.maxIterations < 0 ||
      (this.config.maxFailures !== undefined &&
        (!Number.isSafeInteger(this.config.maxFailures) || this.config.maxFailures < 0))
    )
      throw new Error("invalid evolution iteration budget");
    if (deps.tracer) this.tracer = deps.tracer;
    if (deps.onIteration) this.onIteration = deps.onIteration;
    this.onDiagnostic = deps.onDiagnostic;
  }

  private trace(type: string, data?: JsonValue): void {
    try {
      this.tracer?.emit(type, data);
    } catch (error) {
      try {
        this.onDiagnostic?.(error);
      } catch {}
    }
  }

  async run(): Promise<LoopResult> {
    let current = this.workspace.current();
    this.trace("evaluation.start", { candidate: candidateJson(current), baseline: true });
    let currentSignals: Signal[];
    try {
      currentSignals = await this.evaluator.evaluate(current);
      validateSignals(currentSignals);
    } catch (error) {
      this.trace("evaluation.error", { candidateId: current.id, error: String(error) });
      throw error;
    }
    this.trace("evaluation.end", {
      candidateId: current.id,
      signals: signalsJson(currentSignals),
      baseline: true,
    });
    this.archive.add(current, { signals: currentSignals });
    this.trace("loop.start", {
      root: candidateJson(current),
      maxIterations: this.config.maxIterations,
    });

    const records: IterationRecord[] = [];
    let published = current;
    let publishedSignals = currentSignals;
    const maxFailures = this.config.maxFailures ?? Number.POSITIVE_INFINITY;
    const useArchive = this.config.parentSelection === "archive";
    let failures = 0;

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration += 1) {
      if (failures >= maxFailures) break;

      let parent = current;
      let parentSignals = currentSignals;
      if (useArchive) {
        const sampled = this.archive.selectParent();
        if (sampled) {
          parent = sampled;
          parentSignals = sampled.signals;
          if (sampled.id !== this.workspace.current().id) {
            if (!this.workspace.checkout)
              throw new Error("archive branching requires checkout support");
            await this.workspace.checkout(sampled);
          }
        }
      }

      const outcome = await this.iterate(iteration, parent, parentSignals);
      records.push(outcome.record);
      this.archive.record(outcome.record);
      this.onIteration?.(outcome.record);

      if (outcome.record.accepted && outcome.child && outcome.after) {
        failures = 0;
        current = outcome.child;
        currentSignals = outcome.after;
        if (dominates(currentSignals, publishedSignals)) {
          published = current;
          publishedSignals = currentSignals;
        }
      } else {
        failures += 1;
      }
    }

    // Exploration may keep rejected stepping stones; publication must not use them.
    const best = published;
    if (this.workspace.current().id !== best.id) {
      if (!this.workspace.checkout)
        throw new Error("restoring published candidate requires checkout support");
      await this.workspace.checkout(best);
    }
    await this.workspace.settle?.(best);
    this.trace("loop.end", { best: candidateJson(best), iterations: records.length });
    return { best, records, archive: this.archive };
  }

  private async iterate(
    iteration: number,
    parent: Candidate,
    before: Signal[],
  ): Promise<StepOutcome> {
    this.trace("proposal.start", {
      iteration,
      parent: candidateJson(parent),
      signals: signalsJson(before),
    });
    let proposal: Proposal;
    try {
      await this.workspace.begin?.();
      proposal = await this.proposer.propose(parent, before);
    } catch (error) {
      await this.workspace.abort?.();
      this.trace("proposal.error", { iteration, error: String(error) });
      throw error;
    }
    this.trace("iteration.propose", {
      iteration,
      parentId: parent.id,
      proposalId: proposal.id,
      description: proposal.description,
      artifacts:
        proposal.artifacts?.map((a) => ({
          id: a.id,
          version: a.version,
          snapshot: a.snapshot(),
        })) ?? [],
    });

    if (touchesProtected(parent, proposal)) {
      await this.workspace.abort?.();
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
      await this.workspace.abort?.();
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

    let rollbackAttempted = false;
    const rollback = async () => {
      rollbackAttempted = true;
      await this.rollback(child);
    };
    try {
      if (this.workspace.inspect)
        this.trace("workspace.change", {
          iteration,
          candidateId: child.id,
          change: await this.workspace.inspect(child),
        });
      const gate = this.gates ? await this.gates.check(child) : { passed: true, gate: "none" };
      this.trace("iteration.gate", {
        iteration,
        passed: gate.passed,
        gate: gate.gate,
        ...(gate.reason ? { reason: gate.reason } : {}),
      });
      if (!gate.passed) {
        await rollback();
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

      this.trace("evaluation.start", { iteration, candidateId: child.id });
      const after = await this.evaluator.evaluate(child);
      assertComparableSignals(after, before);
      this.trace("evaluation.end", {
        iteration,
        candidateId: child.id,
        signals: signalsJson(after),
      });
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
        this.trace("workspace.commit.start", { iteration, candidateId: child.id });
        await this.workspace.commit(child);
        this.trace("workspace.commit.end", { iteration, candidateId: child.id, accepted: true });
      } else {
        await rollback();
      }
      return { record, child, after };
    } catch (error) {
      this.trace("iteration.error", { iteration, candidateId: child.id, error: String(error) });
      if (rollbackAttempted) throw error;
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "iteration failed and rollback failed");
      }
      throw error;
    }
  }
  private async rollback(child: Candidate): Promise<void> {
    this.trace("workspace.rollback.start", { candidateId: child.id });
    try {
      await this.workspace.rollback(child);
      this.trace("workspace.rollback.end", { candidateId: child.id });
    } catch (error) {
      this.trace("workspace.rollback.error", { candidateId: child.id, error: String(error) });
      throw error;
    }
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
