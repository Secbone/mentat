import { createHash } from "node:crypto";
import { redact, renderTurnInput } from "@mentat/core";
import { readTrajectory, resolveEventData } from "./trajectory";

export type RecallKind =
  | "memory"
  | "native-history"
  | "imported-history"
  | "procedure"
  | "procedure-catalog";
export type ActionEffect = "read" | "write" | "unknown";
export interface RecallSource {
  id: string;
  scope?: string;
  role?: string;
  state?: string;
  version?: number;
  basis?: string;
  date?: string;
  memoryScope?: string;
  contentSha256?: string;
}
export interface RecallSelection {
  schemaVersion: 1;
  recallId: string;
  turnId: string;
  kind: RecallKind;
  contextName: string;
  contentSha256: string;
  chars: number;
  selectedIds: string[];
  sources: RecallSource[];
  outcome: "hit" | "empty" | "blocked";
  omittedIds: string[] | null;
  omittedMatchingCount?: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const parse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
/** Hash the captured, redacted representation; never claim access to uncaptured bytes. */
export const recallHash = (text: string): string =>
  createHash("sha256")
    .update(String(redact(text)))
    .digest("hex");

function source(value: unknown, kind: RecallKind): RecallSource | undefined {
  const row = object(value);
  const id =
    kind === "procedure" || kind === "procedure-catalog" ? row.name : (row.pointer ?? row.id);
  if (typeof id !== "string") return undefined;
  const content = typeof row.content === "string" ? row.content : row.text;
  return {
    id,
    ...(typeof row.scope === "string" ? { scope: row.scope } : {}),
    ...(typeof (row.role ?? row.speaker) === "string"
      ? { role: String(row.role ?? row.speaker) }
      : {}),
    ...(typeof row.status === "string" ? { state: row.status } : {}),
    ...(typeof (row.version ?? row.revision) === "number"
      ? { version: Number(row.version ?? row.revision) }
      : {}),
    ...(typeof row.basis === "string" ? { basis: row.basis } : {}),
    ...(typeof row.date === "string" ? { date: row.date } : {}),
    ...(typeof row.sourceMemoryScope === "string" ? { memoryScope: row.sourceMemoryScope } : {}),
    ...(typeof content === "string" ? { contentSha256: recallHash(content) } : {}),
  };
}

/** Observation metadata only. This object is never appended to the model prompt. */
export function recallSelection(input: {
  recallId: string;
  turnId: string;
  kind: RecallKind;
  contextName: string;
  text: string;
  selectedIds: string[];
  blocked?: boolean;
  omittedIds?: string[];
  omittedMatchingCount?: number;
  sourceRefs?: Array<{
    id: string;
    scope?: string;
    state?: string;
    version?: number;
    basis?: string;
    role?: string;
  }>;
}): RecallSelection {
  const metadata = new Map(input.sourceRefs?.map((ref) => [ref.id, ref]));
  const sources = input.text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const item = source(parse(line), input.kind);
      return item ? [{ ...item, ...metadata.get(item.id) }] : [];
    });
  return {
    schemaVersion: 1,
    recallId: input.recallId,
    turnId: input.turnId,
    kind: input.kind,
    contextName: input.contextName,
    contentSha256: recallHash(input.text),
    chars: input.text.length,
    selectedIds: [...input.selectedIds],
    sources,
    outcome: input.blocked ? "blocked" : input.text && input.selectedIds.length ? "hit" : "empty",
    omittedIds: input.omittedIds ? [...input.omittedIds] : null,
    ...(input.omittedMatchingCount !== undefined
      ? { omittedMatchingCount: input.omittedMatchingCount }
      : {}),
  };
}

export interface RecallEvidence {
  recallId: string;
  turnId: string;
  kind: RecallKind;
  method: "context" | "tool";
  outcome: "hit" | "empty" | "blocked" | "failed" | "incomplete" | "unparsed";
  sources: RecallSource[];
  selectionSequence: number;
  availableSequence: number | null;
  delivery: "captured-request" | "adapter-result" | "host-input-only" | "none";
  assemblyMatched: boolean | null;
  hostInputMatched: boolean | null;
  beforeFirstWrite: boolean | null;
  firstKnownWriteSequence: number | null;
  unknownActionTools: string[];
  error?: string;
  issues: string[];
  selection?: Pick<
    RecallSelection,
    "contentSha256" | "chars" | "omittedIds" | "omittedMatchingCount"
  >;
}

function reference(input: Record<string, unknown>, name: string): string | undefined {
  if (typeof input.context !== "string") return undefined;
  const blocks = input.context
    .split("\n")
    .filter(Boolean)
    .map((line) => object(parse(line)));
  if (
    blocks.length &&
    blocks.every((block) => typeof block.name === "string" && typeof block.text === "string")
  ) {
    const matches = blocks.filter((block) => block.name === name);
    return matches.length === 1 ? String(matches[0]?.text) : undefined;
  }
  return name === "memory" ? input.context : undefined;
}

/** Source availability and order, not proof of attention, semantic validity or causal benefit. */
export function recallAttribution(dir: string, options: { turnId?: string } = {}) {
  const rows = readTrajectory(dir).map((event) => ({
    ...event,
    value: object(resolveEventData(dir, event)),
  }));
  const policy = rows.find((row) => row.type === "recall.policy")?.value ?? {};
  const reads = object(policy.reads);
  const internal = new Set(strings(policy.internalTools));
  const effects = object(policy.actionEffects);
  const selections = rows.filter(
    (row) => row.type === "recall.selection" || row.type === "recall.error",
  );
  const turns = new Set<string>(
    selections.flatMap((row) => (typeof row.value.turnId === "string" ? [row.value.turnId] : [])),
  );
  for (const row of rows)
    if ((row.type === "turn.start" || row.type === "recall.start") && row.turnId)
      turns.add(row.turnId);
  const evidence: RecallEvidence[] = [];
  const issues: string[] = [];
  if (rows.some((row) => row.type === "capture.gap"))
    issues.push("trajectory has a capture gap; attribution is partial");
  for (const turnId of turns) {
    if (options.turnId && options.turnId !== turnId) continue;
    const local = rows.filter((row) => row.turnId === turnId);
    const start = local.find((row) => row.type === "turn.start");
    const end = local.find((row) => row.type === "turn.end");
    const assembled = local.find((row) => row.type === "prompt.assembled");
    const blocked = local.some((row) => row.type === "recall.blocked");
    const input = object(start?.value.input);
    const connectionId = rows.find(
      (row) => row.type === "session.create.end" && row.value.sessionId === start?.sessionId,
    )?.value.spanId;
    const calls = new Map<string, { name: string; seq: number; result?: (typeof rows)[number] }>();
    for (const row of local) {
      if (row.type !== "agent.event" || typeof row.value.id !== "string") continue;
      const data = row.value;
      if (data.type === "tool.start")
        calls.set(String(data.id), { name: String(data.name), seq: row.seq });
      const call = calls.get(String(data.id));
      if (!call) continue;
      if (data.type === "tool.update" && typeof data.name === "string") call.name = data.name;
      if (data.type === "tool.result") call.result = row;
    }
    const writes = [...calls.values()].filter((call) => effects[call.name] === "write");
    const unknown = [...calls.values()].filter(
      (call) =>
        !reads[call.name] &&
        !internal.has(call.name) &&
        !["read", "write"].includes(String(effects[call.name])),
    );
    const firstWrite = writes.length ? Math.min(...writes.map((call) => call.seq)) : null;
    const beforeWrite = (sequence: number | null): boolean | null => {
      if (sequence === null || firstWrite === null) return null;
      if (sequence >= firstWrite) return false;
      return unknown.some((call) => call.seq <= sequence) ? null : true;
    };
    const common = {
      turnId,
      firstKnownWriteSequence: firstWrite,
      unknownActionTools: [...new Set(unknown.map((call) => call.name))],
    };
    for (const row of local.filter(
      (row) => row.type === "recall.selection" || row.type === "recall.error",
    )) {
      const data = row.value;
      const errors: string[] = [];
      if (row.type === "recall.error") {
        evidence.push({
          ...common,
          recallId: String(data.recallId),
          kind: data.kind as RecallKind,
          method: "context",
          outcome: "failed",
          sources: [],
          selectionSequence: row.seq,
          availableSequence: null,
          delivery: "none",
          assemblyMatched: null,
          hostInputMatched: null,
          beforeFirstWrite: null,
          error: String(data.error),
          issues: [],
        });
        continue;
      }
      const contexts = Array.isArray(assembled?.value.contexts) ? assembled.value.contexts : [];
      const sections = contexts.map(object).filter((part) => part.name === data.contextName);
      const assemblyMatched =
        sections.length === 1 &&
        typeof sections[0]?.text === "string" &&
        recallHash(String(sections[0].text)) === data.contentSha256;
      const actual = reference(input, String(data.contextName));
      const hostInputMatched = actual !== undefined && recallHash(actual) === data.contentSha256;
      const selectedIds = strings(data.selectedIds);
      const sources = Array.isArray(data.sources)
        ? data.sources.filter(
            (value): value is RecallSource => typeof object(value).id === "string",
          )
        : [];
      if (Array.isArray(data.sources) && sources.length !== data.sources.length)
        errors.push("invalid source descriptor");
      if (
        new Set(selectedIds).size !== selectedIds.length ||
        sources.map((s) => s.id).join("\0") !== selectedIds.join("\0")
      )
        errors.push("source identities differ from selected identities");
      const outcome =
        blocked || data.outcome === "blocked"
          ? "blocked"
          : data.outcome === "hit"
            ? "hit"
            : "empty";
      let availableSequence: number | null = null;
      let delivery: RecallEvidence["delivery"] = "none";
      if (outcome === "hit") {
        if (
          (assembled && row.seq >= assembled.seq) ||
          (start && (!assembled || assembled.seq >= start.seq))
        )
          errors.push("recall selection/assembly order is invalid");
        if (!assemblyMatched) errors.push("selected content missing or changed in assembly");
        if (start && !hostInputMatched)
          errors.push("selected content missing or changed in turn input");
        if (assemblyMatched && hostInputMatched && start) {
          delivery = "host-input-only";
          const rendered = renderTurnInput(
            input as unknown as { text: string; context?: string; hostPolicy?: string },
          );
          const matches = rows.filter((candidate) => {
            if (
              candidate.type !== "adapter.protocol" ||
              candidate.seq <= start.seq ||
              (end && candidate.seq >= end.seq) ||
              candidate.value.direction !== "out"
            )
              return false;
            if (!connectionId || candidate.value.connectionId !== connectionId) return false;
            const wire = object(candidate.value.data),
              params = object(wire.params);
            return (
              wire.method === "session/prompt" &&
              Array.isArray(params.prompt) &&
              params.prompt.some(
                (block) => object(block).type === "text" && object(block).text === rendered,
              )
            );
          });
          if (matches.length === 1) {
            delivery = "captured-request";
            availableSequence = matches[0]?.seq ?? null;
          } else if (matches.length > 1)
            errors.push("ambiguous captured delivery; not assigned to a request");
        }
      }
      evidence.push({
        ...common,
        recallId: String(data.recallId),
        kind: data.kind as RecallKind,
        method: "context",
        outcome,
        sources,
        selectionSequence: row.seq,
        availableSequence,
        delivery,
        assemblyMatched,
        hostInputMatched,
        beforeFirstWrite: beforeWrite(availableSequence),
        selection: {
          contentSha256: String(data.contentSha256),
          chars: Number(data.chars),
          omittedIds: data.omittedIds === null ? null : strings(data.omittedIds),
          ...(typeof data.omittedMatchingCount === "number"
            ? { omittedMatchingCount: data.omittedMatchingCount }
            : {}),
        },
        issues: errors,
      });
    }
    for (const row of local.filter((row) => row.type === "recall.start")) {
      if (evidence.some((item) => item.turnId === turnId && item.recallId === row.value.recallId))
        continue;
      evidence.push({
        ...common,
        recallId: String(row.value.recallId),
        kind: row.value.kind as RecallKind,
        method: "context",
        outcome: "incomplete",
        sources: [],
        selectionSequence: row.seq,
        availableSequence: null,
        delivery: "none",
        assemblyMatched: null,
        hostInputMatched: null,
        beforeFirstWrite: null,
        issues: [],
      });
    }
    for (const [id, call] of calls) {
      const kind = reads[call.name] as RecallKind | undefined;
      if (!kind) continue;
      const result = call.result?.value;
      const parsed = typeof result?.output === "string" ? parse(result.output) : undefined;
      const items = Array.isArray(parsed)
        ? parsed
        : kind === "procedure" && parsed
          ? [parsed]
          : undefined;
      const sources =
        items
          ?.map((item) => source(item, kind))
          .filter((item): item is RecallSource => item !== undefined) ?? [];
      const complete = result?.isError === false;
      const outcome: RecallEvidence["outcome"] = !result
        ? "incomplete"
        : result.isError !== false
          ? "failed"
          : !items ||
              sources.length !== items.length ||
              result.outputCoverage === "partial" ||
              result.outputCoverage === "unsupported"
            ? "unparsed"
            : sources.length
              ? "hit"
              : "empty";
      const availableSequence = outcome === "hit" ? (call.result?.seq ?? null) : null;
      evidence.push({
        ...common,
        recallId: id,
        kind,
        method: "tool",
        outcome,
        sources,
        selectionSequence: call.seq,
        availableSequence,
        delivery: complete ? "adapter-result" : "none",
        assemblyMatched: null,
        hostInputMatched: null,
        beforeFirstWrite: beforeWrite(availableSequence),
        issues: [],
      });
    }
  }
  const duplicateIds = new Set<string>();
  for (const item of evidence) {
    const key = JSON.stringify([item.turnId, item.recallId]);
    if (duplicateIds.has(key)) issues.push(`duplicate recall identity: ${key}`);
    duplicateIds.add(key);
    issues.push(...item.issues.map((issue) => `${item.turnId}/${item.recallId}: ${issue}`));
  }
  const byKind = Object.fromEntries(
    (
      [
        "memory",
        "native-history",
        "imported-history",
        "procedure",
        "procedure-catalog",
      ] as RecallKind[]
    ).map((kind) => {
      const subset = evidence.filter((item) => item.kind === kind);
      return [
        kind,
        {
          attempts: subset.length,
          hits: subset.filter((item) => item.outcome === "hit").length,
          empty: subset.filter((item) => item.outcome === "empty").length,
          failed: subset.filter((item) => item.outcome === "failed").length,
          blocked: subset.filter((item) => item.outcome === "blocked").length,
          incomplete: subset.filter((item) => item.outcome === "incomplete").length,
          unparsed: subset.filter((item) => item.outcome === "unparsed").length,
          capturedContextInjections: subset.filter(
            (item) =>
              item.outcome === "hit" &&
              item.method === "context" &&
              item.delivery === "captured-request" &&
              !item.issues.length,
          ).length,
          successfulToolReads: subset.filter(
            (item) => item.method === "tool" && ["hit", "empty", "unparsed"].includes(item.outcome),
          ).length,
          evidenceAvailableBeforeWrite: subset.filter(
            (item) =>
              item.outcome === "hit" && item.beforeFirstWrite === true && !item.issues.length,
          ).length,
        },
      ];
    }),
  );
  return {
    schemaVersion: 1 as const,
    status: issues.length ? "issues" : evidence.length ? "observed" : "unavailable",
    toolPolicyAvailable: Object.keys(policy).length > 0,
    byKind,
    evidence,
    issues,
    limits: [
      "Captured redacted source representation and transport availability only; not proof the model used or understood it.",
      "Original source validity and actual business outcomes require separate audits; no memory is activated here.",
      "Unknown action effects or missing protocol capture produce unknown timing/delivery, never inferred success.",
      "Procedure catalogs are metadata, not complete procedure reads. Legacy traces without recall.selection/policy are not assigned fabricated injections.",
    ],
  };
}
