/**
 * Bridge contract for upstream benchmark sets. The catalog (`catalog.ts`)
 * records *selection policy*; a bridge records how a set is actually run and
 * how far its integration has progressed. Keeping this a pure description (no
 * I/O) lets the CLI/bench tooling register bridges without binding the contract
 * to a specific runner or environment.
 */

export type BridgeRunner = "native" | "harbor" | "upstream" | "benchflow";

/**
 * Ordered integration ladder. Each level implies the previous ones; a level is
 * only claimed when its evidence exists (assets pinned, smoke passed, subject
 * adapter present, full run collected).
 */
export type BridgeIntegration =
  | "catalogued"
  | "source-audited"
  | "pipeline-smoke"
  | "subject-bridged"
  | "full-run";

export interface BenchmarkBridge {
  /** Must match an id in BENCHMARK_CATALOG. */
  id: string;
  source: string;
  /** Pinned upstream revision/commit/sha, when known. */
  revision?: string;
  runner: BridgeRunner;
  /** Repo-relative directory holding assets and the subject adapter. */
  home?: string;
  /** Result adapter id (see @mentat/benchmark-file) used to import results. */
  resultAdapter?: string;
  integration: BridgeIntegration;
  notes?: string;
}

export class BridgeRegistry {
  private readonly bridges = new Map<string, BenchmarkBridge>();

  register(bridge: BenchmarkBridge): void {
    if (!bridge.id.trim()) throw new Error("bridge id is required");
    if (this.bridges.has(bridge.id)) throw new Error(`duplicate bridge: ${bridge.id}`);
    this.bridges.set(bridge.id, bridge);
  }

  get(id: string): BenchmarkBridge | undefined {
    return this.bridges.get(id);
  }

  list(): BenchmarkBridge[] {
    return [...this.bridges.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Current integration state of the selected public sets and native track. */
export function defaultBridges(): BridgeRegistry {
  const registry = new BridgeRegistry();
  for (const bridge of [
    {
      id: "swe-bench-pro-v2",
      source: "https://github.com/scaleapi/SWE-bench_Pro-os",
      revision: "66f92766bba642462d4bbe5479e83f91f9211862",
      runner: "harbor",
      home: "benchmarks/swe-bench",
      resultAdapter: "harbor-trials-v1",
      integration: "subject-bridged",
      notes:
        "Pro V2 development samples: two Python cases passed fresh-sandbox replay; NodeBB separately passed on isolated VZ/Rosetta, including tracked-source-only replay. Different runtime snapshots are not pooled. Not a full run or RSI result. See benchmarks/swe-bench/README.md",
    },
    {
      id: "mentat-longitudinal",
      source: "experiments/personal-assistant",
      runner: "native",
      home: "benchmarks/pilots",
      integration: "full-run",
    },
    {
      id: "longmemeval",
      source: "https://github.com/xiaowu0162/LongMemEval",
      revision: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
      runner: "upstream",
      home: "benchmarks/public",
      integration: "full-run",
      notes: "cleaned-S 500; closed-book host retrieval (mentat-episodic) vs BM25",
    },
    {
      id: "past-bench",
      source: "https://github.com/Gen-Verse/PAST-Bench",
      revision: "f8223517ae7491e776b69793d9f11e9d074ab42e",
      runner: "upstream",
      home: "benchmarks/past-bench",
      integration: "pipeline-smoke",
      notes: "Mentat CLI adapter; SM01 family smoke; dispatch attribution pending",
    },
    {
      id: "rsi-exam",
      source: "https://github.com/aiming-lab/RSI-Exam",
      revision: "1e91cbfa6458aa261d865bdb28fca7b68752a08d",
      runner: "harbor",
      home: "benchmarks/rsi-exam",
      integration: "pipeline-smoke",
      notes: "nop-agent pipeline passes; Mentat agent blocked on sandbox provisioning",
    },
    {
      id: "agentdojo",
      source: "https://github.com/ethz-spylab/agentdojo",
      revision: "089ed468cf3ed0322acc66b0211f26d9d90dbf60",
      runner: "upstream",
      home: "benchmarks/public",
      integration: "pipeline-smoke",
      notes: "one public task preflight with real tools; attack matrix not run",
    },
  ] as const)
    registry.register(bridge);
  return registry;
}
