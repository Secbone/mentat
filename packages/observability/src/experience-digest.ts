import type { ExperienceRecord } from "./experience";

export interface DigestOptions {
  maxRecords?: number;
  maxPromptChars?: number;
  maxChars?: number;
}

/**
 * Compact, deterministic summary of recent experiences, fed into an offline
 * proposer so it can evolve from what actually happened (DGM-style "analyze
 * your own logs").
 */
export function buildExperienceDigest(
  records: ExperienceRecord[],
  options: DigestOptions = {},
): string {
  const maxRecords = options.maxRecords ?? 20;
  const maxPromptChars = options.maxPromptChars ?? 160;
  const maxChars = options.maxChars ?? 4000;

  const recent = records.slice(Math.max(0, records.length - maxRecords));
  if (recent.length === 0) return "";

  const lines = recent.map((record) => {
    const prompt =
      record.prompt.length > maxPromptChars
        ? `${record.prompt.slice(0, maxPromptChars)}…`
        : record.prompt;
    const tools = record.tools.length > 0 ? `tools: ${record.tools.join(",")}; ` : "";
    const feedback = record.feedback?.length
      ? ` feedback=${JSON.stringify(record.feedback)}`
      : " quality=unverified";
    const evidence = record.traceId ? ` trace=${record.traceId} turn=${record.turnId}` : "";
    const error = record.error ? ` — ${record.error}` : "";
    return `- [${record.outcome}] ${prompt} (${tools}${record.toolErrors} errors)${error}${feedback}${evidence}`;
  });

  const block = ["Recent experiences:", ...lines].join("\n");
  return block.length > maxChars ? `${block.slice(0, maxChars)}…` : block;
}
