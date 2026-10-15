import {
  InMemoryMemoryStore,
  type MemoryAudit,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryStore,
  type WriteRequest,
} from "@mentat/memory";
import { JsonlMemoryAudit } from "./audit";
import { commitMemory, mutateMemory, readMemory } from "./transaction.mjs";

/** Compatibility view: reload on every read; every mutation has exclusive ownership. */
export class JsonFileMemoryStore implements MemoryStore {
  constructor(private readonly path: string) {}
  transaction<T>(apply: (view: MemoryStore, audit: MemoryAudit) => T, auditPath?: string): T {
    const records: import("@mentat/memory").MemoryAuditRecord[] = [];
    return mutateMemory(
      this.path,
      (entries) => {
        const view = new InMemoryMemoryStore();
        for (const entry of entries) view.add(entry);
        const result = apply(view, { record: (record) => records.push(record) });
        entries.splice(0, entries.length, ...view.list());
        return result;
      },
      () => records,
      auditPath,
    );
  }
  atomicWrite(request: WriteRequest, now: number, audit?: MemoryAudit) {
    if (
      audit &&
      (!(audit instanceof JsonlMemoryAudit) || audit.path !== `${this.path}.audit.jsonl`)
    )
      throw new Error("file memory requires its transactional audit backend");
    return commitMemory(this.path, request, now);
  }
  add(entry: MemoryEntry): void {
    mutateMemory(this.path, (entries) => {
      const index = entries.findIndex((e) => e.id === entry.id);
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
    });
  }
  search(query: MemoryQuery): MemoryEntry[] {
    const view = new InMemoryMemoryStore();
    for (const entry of this.list()) view.add(entry);
    return view.search(query);
  }
  forget(id: string): boolean {
    return mutateMemory(this.path, (entries) => {
      const index = entries.findIndex((e) => e.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    });
  }
  list(): MemoryEntry[] {
    return readMemory(this.path);
  }
}
