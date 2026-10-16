// Shared, dependency-free write rules for unified memory writing. Imported by
// both the in-process MemoryService (TS) and the standalone MCP server (.mjs),
// so every write path (CLI, MCP, reflection) applies the same rules.
//
// Pure functions only: no I/O, no mutation.

export function normalizeKey(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether an entry should surface during retrieval. Legacy entries without a
 * status are treated as active; candidates only when explicitly requested;
 * superseded/expired/archived never.
 *
 * @param {object} entry
 * @param {boolean} [includeCandidates]
 */
export function isRetrievable(entry, includeCandidates = false) {
  const status = entry.status ?? "active";
  if (status === "active") return true;
  if (status === "candidate") return includeCandidates;
  return false;
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
  if (request.applicability !== undefined) target.applicability = request.applicability;
  if (request.evidence !== undefined) target.evidence = request.evidence;
  if (request.evidenceIds !== undefined) target.evidenceIds = [...request.evidenceIds];
  if (request.evidenceSources !== undefined)
    target.evidenceSources = request.evidenceSources.map((source) => ({ ...source }));
  if (request.tags !== undefined) target.tags = request.tags;
}

function sourceKey(source) {
  return JSON.stringify([
    source.pointer,
    source.origin,
    quoteKey(source.excerpt),
    source.attribution ?? "",
    source.memoryScope ?? "unspecified",
  ]);
}
function unionSources(first = [], second = []) {
  return [
    ...new Map([...first, ...second].map((source) => [sourceKey(source), { ...source }])).values(),
  ];
}
const quoteKey = (text) => text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
const numbers = (text) =>
  JSON.stringify([...new Set(text.match(/[+-]?\d+(?:\.\d+)?/g) ?? [])].sort());

function mergeEvidence(entries, request, now) {
  const target = entries.find((entry) => entry.id === request.targetId);
  if (!target) return { op: "reject", reason: "merge target missing" };
  const reject = (reason) => ({ op: "reject", previous: target, reason });
  if (target.status !== "candidate") return reject("merge cannot modify an established rule");
  if (!Number.isSafeInteger(request.expectedEntryRevision) || request.expectedEntryRevision < 1)
    return reject("merge requires a valid target revision");
  if (target.basis === "user" || target.speaker === "user")
    return reject("merge requires an inferred candidate");
  if (
    target.scope !== request.scope?.trim() ||
    target.kind !== request.kind ||
    (target.applicability ?? "unresolved") !== (request.applicability ?? "unresolved") ||
    (target.condition ?? "") !== (request.condition ?? "")
  )
    return reject("merge kind or scope differs");
  if (!request.evidenceSources?.length) return reject("merge requires resolved evidence");
  const exactClaim = normalizeKey(request.text) === normalizeKey(target.text);
  if (!exactClaim) {
    const shared = request.evidenceSources.some((source) =>
      target.evidenceSources?.some(
        (previous) =>
          previous.pointer === source.pointer &&
          previous.origin === source.origin &&
          previous.attribution === source.attribution &&
          quoteKey(previous.excerpt) === quoteKey(source.excerpt),
      ),
    );
    if (!shared || numbers(request.text) !== numbers(target.text))
      return reject("paraphrase merge requires shared excerpt and unchanged numbers");
  }
  if (request.expectedEntryRevision !== (target.revision ?? 1)) {
    const known = new Set((target.evidenceSources ?? []).map(sourceKey));
    if (
      request.evidenceSources.every((source) => known.has(sourceKey(source))) &&
      (request.evidenceIds ?? []).every((id) => target.evidenceIds?.includes(id))
    )
      return { op: "dedup", entry: target, reason: "merge evidence already present" };
    return reject("merge target revision changed");
  }
  const base = {
    ...target,
    ...(target.evidence === undefined && request.evidence !== undefined
      ? { evidence: request.evidence }
      : {}),
    ...(target.evidenceIds !== undefined || request.evidenceIds !== undefined
      ? {
          evidenceIds: [
            ...new Set([...(target.evidenceIds ?? []), ...(request.evidenceIds ?? [])]),
          ],
        }
      : {}),
    evidenceSources: unionSources(target.evidenceSources, request.evidenceSources),
  };
  const changed = Object.keys(base).some(
    (field) => JSON.stringify(base[field]) !== JSON.stringify(target[field]),
  );
  if (!changed) return { op: "dedup", entry: target, reason: "merge evidence already present" };
  return {
    op: "update",
    previous: target,
    entry: { ...base, revision: (target.revision ?? 1) + 1, createdAt: now },
    reason: "merged evidence; canonical claim unchanged",
  };
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
  if (
    request.evidenceSources !== undefined &&
    (!Array.isArray(request.evidenceSources) ||
      request.evidenceSources.some(
        (source) =>
          !source ||
          typeof source.pointer !== "string" ||
          !source.pointer ||
          typeof source.origin !== "string" ||
          typeof source.excerpt !== "string" ||
          !source.excerpt.trim() ||
          (source.memoryScope !== undefined &&
            !["task", "reusable", "unspecified"].includes(source.memoryScope)) ||
          (source.attribution !== undefined && typeof source.attribution !== "string"),
      ))
  )
    return { op: "reject", reason: "invalid evidence sources" };
  if (
    request.applicability !== undefined &&
    !["task", "reusable", "unresolved"].includes(request.applicability)
  )
    return { op: "reject", reason: "invalid applicability" };
  if (
    request.applicability === "reusable" &&
    request.evidenceSources?.some((source) => source.memoryScope === "task")
  )
    return { op: "reject", reason: "task-local evidence cannot support reusable memory" };
  if (
    request.kind !== undefined &&
    !["preference", "constraint", "fact", "method", "candidate"].includes(request.kind)
  ) {
    return { op: "reject", reason: "invalid kind" };
  }
  if (request.key !== undefined && (typeof request.key !== "string" || !request.key.trim())) {
    return { op: "reject", reason: "empty or invalid key" };
  }
  if (request.scope !== undefined && (typeof request.scope !== "string" || !request.scope.trim())) {
    return { op: "reject", reason: "empty or invalid scope" };
  }
  if (request.mode !== undefined) {
    if (request.mode !== "merge-evidence") return { op: "reject", reason: "invalid write mode" };
    return mergeEvidence(entries, request, now);
  }

  // The caller is a host boundary, not a model-supplied source assertion.
  // MCP must always pass speaker=assistant; a claimed evidence pointer alone
  // neither verifies a user statement nor grants the right to activate a rule.
  const confirmed = request.speaker === "user" && request.basis === "user";
  const basis = confirmed
    ? "user"
    : request.basis === "user"
      ? "inference"
      : (request.basis ?? "unknown");
  const status = confirmed ? (request.status ?? "active") : "candidate";
  if (!["candidate", "active", "superseded", "expired", "archived"].includes(status)) {
    return { op: "reject", reason: "invalid status" };
  }

  const key = request.key !== undefined ? normalizeKey(request.key) : normalizeKey(text);
  const scope = request.scope?.trim();
  const scoped = entries.filter((entry) => entry.scope === scope);
  const existing =
    scoped.find((e) => typeof e.key === "string" && normalizeKey(e.key) === key) ??
    scoped.find((e) => e.text === text && (request.key === undefined || e.key === undefined));

  if (existing && (existing.status ?? "active") !== "candidate" && !confirmed) {
    if (existing.text === text) return { op: "dedup", entry: existing };
    return {
      op: "reject",
      previous: existing,
      reason: "unconfirmed proposal cannot replace an established rule",
    };
  }
  if (
    existing &&
    existing.status === "candidate" &&
    !confirmed &&
    existing.text === text &&
    request.evidenceSources?.length
  ) {
    if (
      (request.kind !== undefined && request.kind !== existing.kind) ||
      (request.applicability ?? "unresolved") !== (existing.applicability ?? "unresolved") ||
      (request.condition ?? "") !== (existing.condition ?? "")
    )
      return { op: "reject", previous: existing, reason: "candidate kind or scope differs" };
    request = {
      ...request,
      evidence: existing.evidence ?? request.evidence,
      ...(existing.evidenceIds !== undefined || request.evidenceIds !== undefined
        ? {
            evidenceIds: [
              ...new Set([...(existing.evidenceIds ?? []), ...(request.evidenceIds ?? [])]),
            ],
          }
        : {}),
      evidenceSources: unionSources(existing.evidenceSources, request.evidenceSources),
    };
  }

  const stableKey = request.key === undefined && existing?.key ? existing.key : key;
  const base = {
    ...existing,
    id: existing?.id ?? deriveId(scope === undefined ? stableKey : `${scope}\0${stableKey}`),
    text,
    key: stableKey,
    kind: request.kind ?? existing?.kind ?? "fact",
    status,
    basis,
  };
  if (existing && existing.text !== text) {
    delete base.evidence;
    delete base.evidenceIds;
    delete base.evidenceSources;
  }
  if (confirmed && existing?.basis !== "user" && request.evidence === undefined) {
    delete base.evidence;
  }
  // Manual confirmation supplies a new user pointer, not the inference's old attribution.
  if (
    confirmed &&
    request.evidence !== undefined &&
    request.evidence !== existing?.evidence &&
    request.evidenceSources === undefined
  )
    delete base.evidenceSources;
  if (request.speaker !== undefined) base.speaker = request.speaker;
  withOptional(base, request);
  if (scope !== undefined) base.scope = scope;

  if (existing) {
    const changed = Object.keys(base).some(
      (field) => JSON.stringify(base[field]) !== JSON.stringify(existing[field]),
    );
    if (!changed) return { op: "dedup", entry: existing };
    const revision = (existing.revision ?? 1) + 1;
    return {
      op: "update",
      previous: existing,
      entry: { ...base, id: existing.id, revision, createdAt: now },
    };
  }
  return { op: "add", entry: { ...base, revision: 1, createdAt: now } };
}
