import type { MemoryRepository, WriteRequest } from "@mentat/memory";
import { commitMemory, memoryRevision, readMemory } from "./transaction.mjs";
export class FileMemoryRepository implements MemoryRepository {
  constructor(readonly path: string) {}
  async snapshot() {
    const entries = readMemory(this.path);
    return { entries, revision: memoryRevision(entries) };
  }
  async commit(request: WriteRequest, options: { expectedRevision?: string; now?: number } = {}) {
    return commitMemory(this.path, request, options.now, options.expectedRevision);
  }
}
