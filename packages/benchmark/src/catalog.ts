import type { Dimension } from "./types";

export interface BenchmarkCatalogEntry {
  id: string;
  name: string;
  priority: "core" | "extended";
  dimensions: Dimension[];
  source: string;
  runtime: string;
  integration: "native-protocol" | "upstream-bridge-required";
  selection: string;
  limitations: string;
}

/** Selection policy, not a claim that datasets or upstream agent bridges are installed. */
export const BENCHMARK_CATALOG: readonly BenchmarkCatalogEntry[] = [
  {
    id: "mentat-longitudinal",
    name: "Mentat longitudinal",
    priority: "core",
    dimensions: ["personalization", "adaptation", "transfer", "interaction"],
    source: "experiments/personal-assistant",
    runtime: "episodes-v1",
    integration: "native-protocol",
    selection: "Independent users; learn, distract, transfer, update, exception and regression",
    limitations:
      "Synthetic/adapted track; explicit confirmation and scripted feedback must be declared",
  },
  {
    id: "past-bench",
    name: "PAST-Bench",
    priority: "core",
    dimensions: ["memory", "transfer", "adaptation", "tool-use"],
    source: "https://github.com/Gen-Verse/PAST-Bench",
    runtime: "upstream PAST-Bench",
    integration: "upstream-bridge-required",
    selection:
      "self-evolve-tasks-v2; start with two families per capability; keep family controls and anchors",
    limitations:
      "Map framework-specific fixtures and persistence telemetry; modifications are adapted track",
  },
  {
    id: "longmemeval",
    name: "LongMemEval cleaned",
    priority: "core",
    dimensions: ["memory", "adaptation"],
    source: "https://github.com/xiaowu0162/LongMemEval",
    runtime: "upstream QA evaluator / Inspect custom task",
    integration: "upstream-bridge-required",
    selection:
      "Cleaned S; stratify extraction, multi-session, update, temporal and abstention; oracle is diagnostic only",
    limitations: "QA memory does not establish useful action or autonomous learning",
  },
  {
    id: "personamem-v2",
    name: "PersonaMem-v2",
    priority: "core",
    dimensions: ["personalization", "adaptation", "safety"],
    source: "https://github.com/bowen-upenn/PersonaMem-v2",
    runtime: "upstream PersonaMem",
    integration: "upstream-bridge-required",
    selection:
      "Text benchmark; hold out persona ids; implicit, updated, third-party and sensitive preference slices",
    limitations:
      "Synthetic histories; do not expose persona labels, answer alternatives or future queries during learning",
  },
  {
    id: "toolsandbox",
    name: "ToolSandbox",
    priority: "core",
    dimensions: ["interaction", "tool-use", "task-quality"],
    source: "https://github.com/apple-aiml-research/ToolSandbox",
    runtime: "upstream ToolSandbox",
    integration: "upstream-bridge-required",
    selection:
      "State dependency, canonicalization and insufficient-information tasks with simulator and state grader",
    limitations: "Preserve tool semantics and user simulator; draft-only tasks are not equivalent",
  },
  {
    id: "tau-bench",
    name: "tau-Bench",
    priority: "core",
    dimensions: ["interaction", "tool-use", "task-quality"],
    source: "https://github.com/sierra-research/tau2-bench",
    runtime: "upstream tau text",
    integration: "upstream-bridge-required",
    selection: "Pinned corrected text release; retail and telecom first; fixed user simulator",
    limitations:
      "Repository now includes tau3; pin task and grading revisions; do not pool versions",
  },
  {
    id: "agentdojo",
    name: "AgentDojo",
    priority: "core",
    dimensions: ["safety", "tool-use"],
    source: "https://github.com/ethz-spylab/agentdojo",
    runtime: "upstream AgentDojo",
    integration: "upstream-bridge-required",
    selection:
      "Workspace/calendar tasks with clean and attacked counterparts; hold out attack templates",
    limitations: "Report attacker success together with benign utility and false rejection",
  },
  {
    id: "memoryagentbench",
    name: "MemoryAgentBench",
    priority: "extended",
    dimensions: ["memory", "adaptation", "transfer"],
    source: "https://github.com/HUST-AI-HYZ/MemoryAgentBench",
    runtime: "upstream MemoryAgentBench",
    integration: "upstream-bridge-required",
    selection: "Four competencies; prioritize FactConsolidation and long-range interference",
    limitations:
      "Retain chunk order; separate original dataset licenses and learning from retrieval",
  },
  {
    id: "personamem-v3",
    name: "PersonaMem-v3",
    priority: "extended",
    dimensions: ["personalization", "adaptation", "safety", "tool-use"],
    source: "https://github.com/bowen-upenn/PersonaMem-v3",
    runtime: "upstream PersonaMem-v3",
    integration: "upstream-bridge-required",
    selection:
      "Time-masked user cohorts; preference lifecycle, over-personalization and agentic tasks",
    limitations:
      "Derived user worlds; code MIT but GIST-derived data CC-BY-NC-4.0; review data use",
  },
  {
    id: "memoryarena",
    name: "MemoryArena",
    priority: "extended",
    dimensions: ["memory", "transfer", "tool-use", "task-quality"],
    source: "https://github.com/ZexueHe/MemoryArena",
    runtime: "upstream MemoryArena",
    integration: "upstream-bridge-required",
    selection: "Shopping, travel, progressive search and reasoning; success by dependency depth",
    limitations: "Preview code and substantial environment setup; preflight each environment",
  },
  {
    id: "skillsbench",
    name: "SkillsBench",
    priority: "extended",
    dimensions: ["transfer", "task-quality", "efficiency"],
    source: "https://github.com/benchflow-ai/skillsbench",
    runtime: "BenchFlow",
    integration: "upstream-bridge-required",
    selection:
      "Pinned v1.1 roster; office, finance and engineering; paired no-skill/curated/learned artifacts",
    limitations: "Expert-provided skills establish skill utility, not autonomous skill acquisition",
  },
  {
    id: "rsi-exam",
    name: "RSI-Exam",
    priority: "extended",
    dimensions: ["self-improvement", "transfer", "task-quality", "efficiency"],
    source: "https://github.com/aiming-lab/RSI-Exam",
    runtime: "Harbor",
    integration: "upstream-bridge-required",
    selection:
      "Public memory/workflow tasks first; immutable development/validation/test split and submitted artifact",
    limitations:
      "Only public subset is downloadable; private full suite needs upstream access; multi-generation claims need a separate protocol",
  },
];

export const FRAMEWORK_CATALOG = [
  {
    id: "harbor",
    source: "https://github.com/harbor-framework/harbor",
    role: "Sandboxed task execution and RSI-Exam; harbor-trials-v1 result adapter implemented",
  },
  {
    id: "inspect",
    source: "https://inspect.aisi.org.uk/agent-bridge.html",
    role: "Dataset/solver/scorer and agent bridge; inspect-json-v1 result adapter implemented",
  },
  {
    id: "benchflow",
    source: "https://github.com/benchflow-ai/benchflow",
    role: "SkillsBench and stateful environments; use normalized-v1 export until a versioned native adapter is added",
  },
  {
    id: "past-bench",
    source: "https://github.com/Gen-Verse/PAST-Bench",
    role: "Longitudinal family/anchor/control methodology; requires a Mentat upstream agent adapter",
  },
  {
    id: "lifelongagentbench",
    source: "https://github.com/caixd-220529/LifelongAgentBench",
    role: "Continual task streams and experience callbacks; optional technical-task backend",
  },
] as const;
