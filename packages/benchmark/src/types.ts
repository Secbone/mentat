export const DIMENSIONS = [
  "task-quality",
  "memory",
  "personalization",
  "adaptation",
  "transfer",
  "interaction",
  "tool-use",
  "safety",
  "self-improvement",
  "observability",
  "efficiency",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface MetricDefinition {
  id: string;
  dimension: Dimension;
  direction: "higher-better" | "lower-better";
  unit: string;
  min?: number;
  max?: number;
  /** Named upstream score/reward. Inspect supports scorer.key for object scores. */
  source?: string;
  /** Explicit conversion only, e.g. Inspect C/I/P. Never coerce strings to numbers. */
  valueMap?: Record<string, number>;
}
export interface TrialUnit {
  caseId: string;
  familyId: string;
  arm: string;
  repetition: number;
  /** Unique upstream trial identity, or episode id for the native runner. */
  sourceId: string;
  metricIds: string[];
}
export interface RunPlan {
  schemaVersion: 1;
  benchmark: { id: string; version: string; track: "upstream" | "adapted" | "smoke" };
  dataset: { revision: string; sha256: string; split: string; source: string };
  scorer: { id: string; revision: string; config: Record<string, unknown> };
  protocol: {
    id: string;
    revision: string;
    /** Includes persistence, confirmation, permission, prompt and environment policy. */
    config: Record<string, unknown>;
    arms: Array<{ id: string; memory: "reset" | "explicit" | "reflect" }>;
    maxCalls: number;
    turnTimeoutMs: number;
  };
  subject: {
    id: string;
    revision: string;
    /** Revision + dirty diff fingerprint; benchmark CLI captures the current tree. */
    codeSha256: string;
    harness: string;
    harnessVersion: string;
    model: string;
    modelVersion: string;
    config: Record<string, unknown>;
  };
  metrics: MetricDefinition[];
  units: TrialUnit[];
}
export interface Measurement {
  value: number | null;
  reason?: string;
}
export interface TrialResult {
  caseId: string;
  familyId: string;
  arm: string;
  repetition: number;
  status: "completed" | "error" | "skipped" | "missing";
  metrics: Record<string, Measurement>;
  /** Full outputs/trace paths belong here, not in model-visible inputs. */
  evidence: string[];
  error?: string;
  durationMs: number | null;
  costUsd: number | null;
  reflection?: {
    status: "completed" | "invalid" | "error";
    added?: number;
    merged?: number;
    skipped?: number;
    rejected?: number;
    error?: string;
  };
  observations?: Record<string, unknown>;
}
export interface BenchmarkRun {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  plan: RunPlan;
  provenance: {
    adapter: string;
    adapterVersion: string;
    artifactSha256: string;
    execution: "imported" | "completed" | "failed";
    executionConfigSha256?: string;
    notes: string[];
  };
  results: TrialResult[];
}
export interface ResultAdapter {
  id: string;
  version: string;
  /** Must return per-trial records; aggregate-only results cannot establish coverage. */
  read(input: unknown, plan: RunPlan): TrialResult[];
}
export interface RuleCheck {
  metricId: string;
  turn: number;
  kind: "exact" | "includes" | "json-equals" | "json-criteria";
  expected: string;
}
export interface EpisodeInput {
  text: string;
  hostPolicy?: string;
  memoryScope?: "task" | "reusable" | "unspecified";
  materials?: Array<{
    text: string;
    attribution?: string;
    memoryScope?: "task" | "reusable" | "unspecified";
  }>;
}
export interface ExplicitMemory {
  text: string;
  kind: "fact" | "preference" | "constraint" | "method";
  key?: string;
  condition?: string;
}
export interface EpisodeDataset {
  schemaVersion: 1;
  episodes: Array<{
    id: string;
    familyId: string;
    phase: "learn" | "probe" | "update" | "exception" | "regression";
    turns: Array<{
      input: EpisodeInput;
      remember?: ExplicitMemory[];
      when?: { previousTurn: number; unless: import("./criteria").JsonCriteria };
    }>;
    checks: RuleCheck[];
  }>;
}
export interface SubjectTurn {
  text: string;
  ok: boolean;
  costUsd: number | null;
  evidence: string[];
}
/** Factory receives identity/policy only: never answers, checks or future tasks. */
export interface BenchmarkSubject {
  turn(input: EpisodeInput): Promise<SubjectTurn>;
  remember(input: ExplicitMemory): Promise<void>;
  reflect(): Promise<{
    costUsd: number | null;
    evidence: string[];
    result?: NonNullable<TrialResult["reflection"]>;
  }>;
  close(): Promise<void | {
    costUsd: number | null;
    evidence: string[];
    observations?: Record<string, unknown>;
  }>;
}
export interface SubjectContext {
  stateKey: string;
  unit: TrialUnit;
  memory: "reset" | "explicit" | "reflect";
}
export type SubjectFactory = (context: SubjectContext) => Promise<BenchmarkSubject>;
