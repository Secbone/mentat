import type { ExperienceRecord } from "@mentat/session";
import { historicalContext } from "./history";

/** Native interactions remain observations. This never changes memory confirmation state. */
export function nativeContext(
  records: ExperienceRecord[],
  query: string,
  options: { maxChars: number; cwd: string; scope?: string; before?: number },
) {
  let excludedMessages = 0;
  const eligible = records.filter(
    (record) =>
      !record.imported &&
      Number.isFinite(record.ts) &&
      Number.isFinite(new Date(record.ts).getTime()) &&
      (options.scope !== undefined
        ? record.scope === options.scope
        : record.scope === undefined && record.cwd === options.cwd),
  );
  const observations = eligible.map(
    (record): ExperienceRecord => ({
      ...record,
      // Temporary retrieval metadata only; do not rewrite the durable record as an import.
      imported: { source: "native-interaction", sessionId: record.id, timestampKnown: true },
      messages: (record.messages ?? []).map((message) => {
        if (message.role === "assistant") return { ...message, fragments: undefined };
        if (message.role !== "user" || !message.fragments) {
          excludedMessages++;
          return { ...message, text: "", fragments: [] };
        }
        // Never re-ingest host policy, quoted third-party material or prior injected history.
        const fragments = message.fragments.filter((fragment) => fragment.origin === "user");
        const scope = fragments.some((f) => f.memoryScope === "task")
          ? "task"
          : fragments.length > 0 && fragments.every((f) => f.memoryScope === "reusable")
            ? "reusable"
            : "unspecified";
        const text = fragments.map((fragment) => fragment.text).join("\n");
        if (!text) excludedMessages++;
        return { ...message, text, fragments: [{ origin: "user", text, memoryScope: scope }] };
      }),
    }),
  );
  return {
    ...historicalContext(observations, query, { ...options, wholeMessages: true }),
    sourceKind: "native-interaction" as const,
    excludedMessages,
  };
}
