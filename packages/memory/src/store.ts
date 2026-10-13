export interface MemoryEntry {
  id: string;
  text: string;
  tags?: string[];
  createdAt: number;
}

export interface MemoryQuery {
  text?: string;
  tags?: string[];
  limit?: number;
}

/** A store the agent (and the loop) can grow, query and forget. */
export interface MemoryStore {
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
