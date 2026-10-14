// Shared, dependency-free write rules for unified memory writing. Imported by
// both the in-process MemoryService (TS) and the standalone MCP server (.mjs),
// so every write path (CLI, MCP, reflection) applies the same rules.
//
// Pure functions only: no I/O, no mutation.

export function normalizeKey(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

export function deriveId(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  }
  return `mem-${(hash >>> 0).toString(36)}`;
}

function withOptional(target, request) {
  if (request.kind !== undefined) target.kind = request.kind;
  if (request.scope !== undefined) target.scope = request.scope;
  if (request.condition !== undefined) target.condition = request.condition;
  if (request.evidence !== undefined) target.evidence = request.evidence;
  if (request.tags !== undefined) target.tags = request.tags;
}

/**
 * Decide what a write should do, given the current entries. Host-side source
 * checks live here: a model/assistant may not claim a fact came from the user,
 * and model-derived writes default to `candidate` (not yet a user rule).
 *
 * @param {Array} entries
 * @param {object} request
 * @param {number} now
 */
export function decideWrite(entries, request, now) {
  const text = typeof request.text === "string" ? request.text.trim() : "";
  if (text.length === 0) return { op: "reject", reason: "empty text" };

  let basis = request.basis;
  let status = request.status;
  if (request.speaker === "assistant" && basis === "user") {
    basis = "inference"; // a model cannot self-attest that the user said it
    if (status === undefined) status = "candidate";
  }
  if (status === undefined) status = request.speaker === "assistant" ? "candidate" : "active";

  const key = request.key !== undefined ? normalizeKey(request.key) : normalizeKey(text);
  const existing =
    entries.find((e) => typeof e.key === "string" && normalizeKey(e.key) === key) ??
    entries.find((e) => e.text === text);

  const base = { id: deriveId(key), text, key, status, ...(basis !== undefined ? { basis } : {}) };
  if (request.speaker !== undefined) base.speaker = request.speaker;
  withOptional(base, request);

  if (existing) {
    if (existing.text === text) return { op: "dedup", entry: existing };
    const revision = (existing.revision ?? 1) + 1;
    return {
      op: "update",
      previous: existing,
      entry: { ...base, id: existing.id, revision, createdAt: now },
    };
  }
  return { op: "add", entry: { ...base, revision: 1, createdAt: now } };
}
