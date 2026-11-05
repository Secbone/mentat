import { join } from "node:path";
import type { Policy } from "@mentat/domain";
import { EffectQueue } from "@mentat/effects";
import { FileRepositories } from "@mentat/store";
import type { WorkerAdapter } from "@mentat/worker";
import { FakeWorker } from "@mentat/worker";
import { FileReceiptSink } from "./file-receipts";
import { MentatRuntime, type ReceiptSink, type RouterAgentPort } from "./runtime";

export interface MentatServiceOptions {
  dir: string;
  worker?: WorkerAdapter;
  agents?: RouterAgentPort;
  receipts?: ReceiptSink;
  policy?: Policy;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface MentatService {
  runtime: MentatRuntime;
  repos: FileRepositories;
  queue: EffectQueue;
  receipts: ReceiptSink;
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
  });
  return { runtime, repos, queue, receipts };
}
