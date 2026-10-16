export type MemoryKind = "preference" | "constraint" | "fact" | "method" | "candidate";
export type MemoryBasis = "user" | "tool" | "observation" | "inference" | "unknown";
export type MemoryStatus = "candidate" | "active" | "superseded" | "expired" | "archived";
export type MemorySpeaker = "user" | "assistant" | "tool" | "system";

/** Host-resolved source excerpts. Presence is not proof of semantic support. */
export interface MemoryEvidenceSource {
  pointer: string;
  origin: string;
  excerpt: string;
  attribution?: string;
  memoryScope?: "task" | "reusable" | "unspecified";
}

/** Effective status of an entry; legacy entries without one are treated as active. */
export function memoryStatus(entry: MemoryEntry): MemoryStatus {
  return entry.status ?? "active";
}

export interface MemoryEntry {
  id: string;
  text: string;
  /** Stable rule key; wording changes don't create a new rule. Defaults to normalized text. */
  key?: string;
  kind?: MemoryKind;
  /** Where the claim comes from: explicit user statement, tool observation, or inference. */
  basis?: MemoryBasis;
  /** Applicability: user / project / task-type / audience. */
  scope?: string;
  condition?: string;
  /** Reuse scope, separate from the user/project namespace in scope. */
  applicability?: "task" | "reusable" | "unresolved";
  status?: MemoryStatus;
  /** Message id, tool-call id, or other evidence pointer. */
  evidence?: string;
  speaker?: MemorySpeaker;
  revision?: number;
  tags?: string[];
  createdAt: number;
  /** Provenance for memories extracted from observable interactions. */
  evidenceIds?: string[];
  evidenceSources?: MemoryEvidenceSource[];
}

export interface MemoryQuery {
  text?: string;
  tags?: string[];
  limit?: number;
  /** Only return entries whose effective status is in this set (undefined = any). */
  statuses?: MemoryStatus[];
}

/** A store the agent (and the loop) can grow, query and forget. */
export interface MemoryStore {
  atomicWrite?(
    request: import("./write-rules.mjs").WriteRequest,
    now: number,
    audit?: import("./service").MemoryAudit,
  ): import("./service").MemoryWriteResult;
  add(entry: MemoryEntry): void;
  search(query: MemoryQuery): MemoryEntry[];
  forget(id: string): boolean;
  list(): MemoryEntry[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** Keyword-overlap memory store; deterministic and dependency-free. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  add(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
  }

  list(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  forget(id: string): boolean {
    return this.entries.delete(id);
  }

  search(query: MemoryQuery): MemoryEntry[] {
    const terms = query.text ? tokenize(query.text) : [];
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      if (query.statuses && !query.statuses.includes(memoryStatus(entry))) continue;
      if (query.tags && query.tags.length > 0) {
        const tags = entry.tags ?? [];
        if (!query.tags.every((tag) => tags.includes(tag))) continue;
      }
      if (terms.length === 0) {
        scored.push({ entry, score: 0 });
        continue;
      }
      const tokens = new Set(tokenize(entry.text));
      const score = terms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt);
    const limit = query.limit ?? scored.length;
    return scored.slice(0, limit).map((item) => item.entry);
  }
}
