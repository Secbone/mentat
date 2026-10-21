import { tokenize as baseTokenize } from "@mentat/memory";
import type { ExperienceRecord } from "@mentat/session";

/** Historical observations are reference data, never a manual confirmation. */
export interface HistoricalSession {
  id: string;
  source: string;
  timestamp?: number;
  /** Explicit source order for documents without a calendar timestamp. */
  order?: number;
  messages: Array<{ role: "user" | "assistant" | "system" | "tool" | "document"; content: string }>;
}

export function validateHistoricalSessions(input: unknown): HistoricalSession[] {
  if (!Array.isArray(input)) throw new TypeError("history requires an array of sessions");
  const ids = new Set<string>();
  for (const session of input) {
    if (!session || typeof session !== "object") throw new TypeError("invalid history session");
    if (
      Object.keys(session).some(
        (key) => !["id", "source", "timestamp", "order", "messages"].includes(key),
      )
    )
      throw new TypeError("unrecognized history field; strip evaluation labels before ingestion");
    if (
      typeof session.id !== "string" ||
      !session.id.trim() ||
      typeof session.source !== "string" ||
      !session.source.trim()
    )
      throw new TypeError("history requires source and id");
    if (
      session.timestamp !== undefined &&
      (!Number.isFinite(session.timestamp) ||
        !Number.isFinite(new Date(session.timestamp).getTime()))
    )
      throw new TypeError("history timestamp must be epoch milliseconds");
    if (session.order !== undefined && (!Number.isSafeInteger(session.order) || session.order < 0))
      throw new TypeError("invalid history source order");
    if (session.timestamp === undefined && session.order === undefined)
      throw new TypeError("history requires a timestamp or explicit source order");
    const key = JSON.stringify([session.source, session.id]);
    if (ids.has(key)) throw new TypeError("duplicate historical session identity");
    ids.add(key);
    if (!Array.isArray(session.messages) || !session.messages.length)
      throw new TypeError("history requires messages");
    for (const message of session.messages) {
      if (
        !message ||
        Object.keys(message).some((key) => !["role", "content"].includes(key)) ||
        !["user", "assistant", "system", "tool", "document"].includes(message.role) ||
        typeof message.content !== "string"
      )
        throw new TypeError("history messages require role/content only");
    }
  }
  return structuredClone(input);
}

export function historicalExperience(
  session: HistoricalSession,
  cwd: string,
  scope?: string,
): ExperienceRecord {
  return {
    id: `history:${JSON.stringify(scope === undefined ? [session.source, session.id] : [scope, session.source, session.id])}`,
    ...(scope !== undefined ? { scope } : {}),
    ts: session.timestamp ?? 0,
    prompt: "Imported historical conversation; reference data, not a live instruction.",
    cwd,
    harness: "history-import",
    outcome: "done",
    tools: [],
    toolErrors: 0,
    imported: {
      source: session.source,
      sessionId: session.id,
      timestampKnown: session.timestamp !== undefined,
      ...(session.order !== undefined ? { order: session.order } : {}),
    },
    messages: session.messages.map((message, index) => ({
      role: message.role,
      index,
      text: message.content,
      fragments: [
        {
          origin:
            message.role === "system" || message.role === "document"
              ? "quoted-material"
              : message.role,
          text: message.content,
          memoryScope: "unspecified",
          ...(message.role === "system" || message.role === "document"
            ? {
                attribution:
                  "historical system/document source; reference only, not current execution policy",
              }
            : {}),
        },
      ],
    })),
  };
}

/** Query-time lexical retrieval over raw observations, without activating inferred rules. */
export function historicalContext(
  records: ExperienceRecord[],
  query: string,
  options: {
    maxChars: number;
    before?: number;
    wholeMessages?: boolean;
    scope?: string;
    cwd?: string;
  },
) {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0)
    throw new RangeError("invalid historical context budget");
  if (options.before !== undefined && !Number.isFinite(options.before))
    throw new RangeError("invalid historical cutoff");
  const stop = new Set(
    "a an the i me my you your we our is are was were be been do does did have has had to of for in on at from with and or that this it as what which how can could would should please based relevant historical observations current date question answer".split(
      " ",
    ),
  );
  const tokenize = (text: string) => baseTokenize(text).filter((word) => !stop.has(word));
  const terms = new Set(tokenize(query));
  type Piece = {
    id: string;
    session: string;
    text: string;
    words: string[];
    score: number;
    ts: number;
    messageIndex: number;
  };
  const pieces: Piece[] = [];
  let eligibleSessions = 0;
  for (const record of records) {
    if (
      !record.imported ||
      record.scope !== options.scope ||
      (options.scope === undefined && options.cwd !== undefined && record.cwd !== options.cwd) ||
      (options.before !== undefined &&
        (record.imported.timestampKnown === false || record.ts > options.before))
    )
      continue;
    eligibleSessions++;
    for (const [messageIndex, message] of (record.messages ?? []).entries()) {
      const stride = options.wholeMessages ? Math.max(1, message.text.length) : 1000;
      for (let offset = 0; offset < message.text.length; offset += stride) {
        const content = message.text.slice(
          offset,
          options.wholeMessages ? undefined : offset + 1200,
        );
        const id = `${record.id}#msg${messageIndex}:${offset}`;
        const text = JSON.stringify({
          source: record.imported.source,
          session: record.imported.sessionId,
          date: record.imported.timestampKnown === false ? null : new Date(record.ts).toISOString(),
          ...(record.imported.order !== undefined ? { order: record.imported.order } : {}),
          role: message.role,
          ...(options.wholeMessages
            ? {
                sourceMemoryScope: message.fragments?.[0]?.memoryScope ?? "unspecified",
                engineOutcome: record.outcome,
                ...(record.scope !== undefined ? { scope: record.scope } : {}),
              }
            : {}),
          pointer: id,
          content,
        });
        pieces.push({
          id,
          session: record.id,
          text,
          words: tokenize(content),
          score: 0,
          ts: record.imported.order ?? record.ts,
          messageIndex,
        });
      }
    }
  }
  const frequency = new Map<string, number>();
  for (const piece of pieces)
    for (const word of new Set(piece.words))
      if (terms.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const averageLength = pieces.reduce((n, p) => n + p.words.length, 0) / (pieces.length || 1) || 1;
  for (const piece of pieces) {
    const counts = new Map<string, number>();
    for (const word of piece.words)
      if (terms.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const [term, count] of counts) {
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (pieces.length - df + 0.5) / (df + 0.5));
      piece.score +=
        (idf * count * 2.2) / (count + 1.2 * (0.25 + (0.75 * piece.words.length) / averageLength));
    }
  }
  const candidates = pieces.filter((piece) => piece.score > 0);
  const matchingChunks = candidates.length;
  const selected: Piece[] = [],
    selectedIds = new Set<string>();
  const bySession = new Map<string, number>();
  let chars = 0;
  const add = (piece: Piece) => {
    if (selectedIds.has(piece.id) || chars + piece.text.length + 1 > options.maxChars) return false;
    selected.push(piece);
    selectedIds.add(piece.id);
    chars += piece.text.length + 1;
    bySession.set(piece.session, (bySession.get(piece.session) ?? 0) + 1);
    return true;
  };
  // Retain the strongest evidence first, then diversify across sessions instead of
  // filling the budget with repeated mentions from a single conversation.
  while (candidates.length) {
    candidates.sort(
      (a, b) =>
        b.score / (1 + (bySession.get(b.session) ?? 0) * 0.35) -
          a.score / (1 + (bySession.get(a.session) ?? 0) * 0.35) ||
        b.ts - a.ts ||
        a.id.localeCompare(b.id),
    );
    const piece = candidates.shift();
    if (piece) add(piece);
    if (chars >= options.maxChars * 0.8) break;
  }
  // Short adjacent replies often resolve references ("that one", "yes", dates).
  // They retain their original roles; relevance never implies user confirmation.
  for (const anchor of [...selected]) {
    for (const piece of pieces)
      if (
        piece.session === anchor.session &&
        Math.abs(piece.messageIndex - anchor.messageIndex) <= 1
      )
        add(piece);
  }
  for (const piece of candidates) add(piece);
  selected.sort(
    (a, b) =>
      a.ts - b.ts ||
      a.session.localeCompare(b.session) ||
      a.messageIndex - b.messageIndex ||
      a.id.localeCompare(b.id),
  );
  return {
    text: selected.map((p) => p.text).join("\n"),
    selectedIds: selected.map((p) => p.id),
    eligibleSessions,
    matchingChunks,
    omittedChunks: matchingChunks - selected.filter((p) => p.score > 0).length,
    chars,
    selectedSessions: bySession.size,
    strategy: options.wholeMessages
      ? "bm25-atomic-messages-v1"
      : "bm25-session-diversity-neighbors-v1",
  };
}
