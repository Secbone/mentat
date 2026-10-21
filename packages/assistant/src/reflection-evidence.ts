import type { MemoryEntry } from "@mentat/memory";
import type {
  EvidenceFragment,
  EvidenceMemoryScope,
  EvidenceOrigin,
  ExperienceRecord,
} from "@mentat/session";

export interface ReflectionSource {
  ref: string;
  recordId: string;
  pointer: string;
  origin: EvidenceOrigin;
  text: string;
  attribution?: string;
  memoryScope: EvidenceMemoryScope;
}
export interface ReflectionBatch {
  id: string;
  sources: ReflectionSource[];
  memories: Array<{ ref: string; entry: MemoryEntry }>;
  records: Array<{
    ref: string;
    outcome: string;
    termination?: ExperienceRecord["termination"];
    completion?: ExperienceRecord["completion"];
    tools: string[];
    error?: string;
    feedback?: ExperienceRecord["feedback"];
  }>;
}

/** Aliases are short and local to one random batch; full pointers never depend on model copying UUIDs. */
export function buildReflectionBatch(
  interactions: ExperienceRecord[],
  memories: MemoryEntry[] = [],
): ReflectionBatch {
  let candidateIndex = 0,
    establishedIndex = 0;
  const batch: ReflectionBatch = {
    id: `R${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    sources: [],
    memories: memories.map((entry) => ({
      ref: entry.status === "candidate" ? `C${++candidateIndex}` : `A${++establishedIndex}`,
      entry: structuredClone(entry),
    })),
    records: [],
  };
  const ids = new Set<string>();
  for (const [recordIndex, record] of interactions.entries()) {
    if (ids.has(record.id)) throw new Error(`duplicate reflection record: ${record.id}`);
    ids.add(record.id);
    const ref = `E${recordIndex + 1}`;
    batch.records.push({
      ref,
      outcome: record.outcome,
      ...(record.termination ? { termination: structuredClone(record.termination) } : {}),
      ...(record.completion ? { completion: structuredClone(record.completion) } : {}),
      tools: [...record.tools],
      ...(record.error ? { error: record.error } : {}),
      ...(record.feedback?.length ? { feedback: structuredClone(record.feedback) } : {}),
    });
    if (record.error)
      batch.sources.push({
        ref: `${ref}.ERROR`,
        recordId: record.id,
        pointer: `exp:${record.id}#error`,
        origin: "legacy",
        memoryScope: "unspecified",
        text: record.error,
      });
    for (const [feedbackIndex, feedback] of (record.feedback ?? []).entries()) {
      if (feedback.correction)
        batch.sources.push({
          ref: `${ref}.F${feedbackIndex + 1}`,
          recordId: record.id,
          pointer: `exp:${record.id}#feedback${feedbackIndex}`,
          origin: feedback.source === "user" ? "user" : "legacy",
          memoryScope: "unspecified",
          text: feedback.correction,
        });
    }
    const messages = record.messages?.length
      ? record.messages
      : [{ role: "user" as const, text: record.prompt }];
    for (const [messageIndex, message] of messages.entries()) {
      const fragments: EvidenceFragment[] = message.fragments ?? [
        {
          origin: message.role === "assistant" ? ("assistant" as const) : ("legacy" as const),
          text: message.text,
        },
      ];
      for (const [partIndex, fragment] of fragments.entries()) {
        batch.sources.push({
          ref: `${ref}.M${messageIndex + 1}.P${partIndex + 1}`,
          recordId: record.id,
          pointer: `exp:${record.id}${record.messages?.length ? `#msg${messageIndex}` : "#prompt"}${message.fragments ? `/part${partIndex}` : ""}`,
          origin: fragment.origin,
          memoryScope:
            fragment.memoryScope ??
            (fragment.origin === "host-policy" || fragment.origin === "quoted-material"
              ? "task"
              : "unspecified"),
          text: fragment.text,
          ...(fragment.attribution !== undefined ? { attribution: fragment.attribution } : {}),
        });
      }
    }
    for (const [toolIndex, tool] of (record.toolCalls ?? []).entries()) {
      batch.sources.push({
        ref: `${ref}.T${toolIndex + 1}`,
        recordId: record.id,
        pointer: `exp:${record.id}#tool${toolIndex}`,
        origin: "tool",
        memoryScope: "unspecified",
        text: JSON.stringify(tool),
      });
    }
  }
  return batch;
}

/** Model sees source labels, excerpts and aliases; stable full IDs stay in the host mapping. */
export function reflectionEvidenceData(batch: ReflectionBatch) {
  return {
    batchId: batch.id,
    records: batch.records,
    memories: batch.memories.map(({ ref, entry }) => ({
      ref,
      text: entry.text,
      kind: entry.kind,
      status: entry.status ?? "active",
      mergeAllowed:
        entry.status === "candidate" && entry.basis !== "user" && entry.speaker !== "user",
      applicability: entry.applicability ?? "unresolved",
      condition: entry.condition,
      evidenceSources: entry.evidenceSources?.map(({ origin, excerpt, memoryScope }) => ({
        origin,
        excerpt,
        memoryScope,
      })),
    })),
    sources: batch.sources.map(({ recordId: _recordId, pointer: _pointer, ...source }) => source),
  };
}
