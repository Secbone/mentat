import { join } from "node:path";
import type { Policy, SourceKind } from "@mentat/domain";
import { EffectQueue } from "@mentat/effects";
import {
  DreamService,
  EvolutionLoop,
  PackArchive,
  type PackEvaluator,
  RulePackProposer,
} from "@mentat/evolve";
import type { CapabilityPack } from "@mentat/pack";
import { FileRepositories } from "@mentat/store";
import type { WorkerAdapter } from "@mentat/worker";
import { FakeWorker } from "@mentat/worker";
import { EvolutionScheduler } from "./evolution-scheduler";
import { MentatEvolver } from "./evolver";
import { FileReceiptSink } from "./file-receipts";
import { SourcePoller } from "./poller";
import {
  MentatRuntime,
  type ReceiptSink,
  type ReceiptStore,
  type RouterAgentPort,
} from "./runtime";

export interface MentatServiceOptions {
  dir: string;
  worker?: WorkerAdapter;
  agents?: RouterAgentPort;
  receipts?: ReceiptSink;
  packs?: PackArchive;
  evaluator?: PackEvaluator;
  policy?: Policy;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  pack?: CapabilityPack;
  source?: SourceKind;
  pollIntervalMs?: number;
  onPollError?: (error: unknown) => void;
  evolveIntervalMs?: number;
  maxObservations?: number;
  onEvolveError?: (error: unknown) => void;
}

export interface MentatService {
  runtime: MentatRuntime;
  repos: FileRepositories;
  queue: EffectQueue;
  receipts: ReceiptSink;
  packs: PackArchive;
  dream?: DreamService;
  evolver?: MentatEvolver;
  evolutionScheduler?: EvolutionScheduler;
  poller?: SourcePoller;
}

const DEFAULT_POLICY: Policy = {
  version: 1,
  acceptMode: "auto",
  rules: [],
  sources: {
    local: {
      allowed: ["local-user"],
      bots: [],
      admission: {
        listedUnaddressed: "inferred",
        unlistedAddressed: "ignore",
        unlistedUnaddressed: "ignore",
      },
    },
  },
};

/** Compose the control plane used by the DSH plugin and its tests. */
export function createMentatService(options: MentatServiceOptions): MentatService {
  const repos = new FileRepositories(join(options.dir, "state"));
  const queue = new EffectQueue({ path: join(options.dir, "effects.json") });
  const receipts = options.receipts ?? new FileReceiptSink(join(options.dir, "receipts.jsonl"));
  const packs = options.packs ?? new PackArchive(join(options.dir, "packs.json"));
  const runtime = new MentatRuntime({
    repos,
    queue,
    worker: options.worker ?? new FakeWorker(),
    receipts,
    policy: () => options.policy ?? DEFAULT_POLICY,
    cwd: options.dir,
    ...(options.agents ? { agents: options.agents } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.pack ? { pack: options.pack } : {}),
  });
  const dream = options.evaluator
    ? new DreamService(
        new EvolutionLoop({
          proposer: new RulePackProposer(),
          evaluator: options.evaluator,
          archive: packs,
        }),
      )
    : undefined;
  let evolver: MentatEvolver | undefined;
  if (dream && receipts.list) {
    evolver = new MentatEvolver({
      receipts: receipts as ReceiptStore,
      packs,
      dream,
      currentPack: () => runtime.currentPack,
      ...(options.maxObservations !== undefined
        ? { maxObservations: options.maxObservations }
        : {}),
    });
  }
  const evolutionScheduler =
    evolver && options.evolveIntervalMs
      ? new EvolutionScheduler({
          evolver,
          intervalMs: options.evolveIntervalMs,
          ...(options.onEvolveError ? { onError: options.onEvolveError } : {}),
        })
      : undefined;
  const poller = options.source
    ? new SourcePoller({
        source: options.source,
        runtime,
        intervalMs: options.pollIntervalMs ?? 60_000,
        ...(options.onPollError ? { onError: options.onPollError } : {}),
      })
    : undefined;
  return {
    runtime,
    repos,
    queue,
    receipts,
    packs,
    ...(dream ? { dream } : {}),
    ...(evolver ? { evolver } : {}),
    ...(evolutionScheduler ? { evolutionScheduler } : {}),
    ...(poller ? { poller } : {}),
  };
}
