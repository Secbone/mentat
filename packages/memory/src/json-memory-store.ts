import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { InMemoryMemoryStore, type MemoryEntry, type MemoryQuery, type MemoryStore } from "./store";

/**
 * A {@link MemoryStore} persisted as a JSON file. Reads on construction and
 * writes on every mutation, so the evolved memory survives across runs.
 */
export class JsonFileMemoryStore implements MemoryStore {
  private readonly inner = new InMemoryMemoryStore();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (Array.isArray(data)) {
        for (const entry of data as MemoryEntry[]) this.inner.add(entry);
      }
    } catch {
      /* a corrupt store starts empty rather than crashing */
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.inner.list(), null, 2)}\n`);
  }

  add(entry: MemoryEntry): void {
    this.inner.add(entry);
    this.save();
  }

  search(query: MemoryQuery): MemoryEntry[] {
    return this.inner.search(query);
  }

  forget(id: string): boolean {
    const removed = this.inner.forget(id);
    if (removed) this.save();
    return removed;
  }

  list(): MemoryEntry[] {
    return this.inner.list();
  }
}
