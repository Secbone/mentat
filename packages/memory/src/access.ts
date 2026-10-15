import { buildTurnContext } from "./context";
import type { MemoryWriteResult } from "./service";
import { InMemoryMemoryStore, type MemoryEntry, type MemoryQuery } from "./store";
import type { WriteRequest } from "./write-rules.mjs";

export interface MemorySnapshot {
  revision: string;
  entries: MemoryEntry[];
}
export interface MemoryRepository {
  snapshot(): Promise<MemorySnapshot>;
  /** Atomic decision + data + audit, with optional optimistic concurrency. Pending commits must report recovery status. */
  commit(
    request: WriteRequest,
    options?: { expectedRevision?: string; now?: number },
  ): Promise<MemoryWriteResult>;
}
export interface MemoryAccess {
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  context(task: string, maxChars?: number): Promise<ReturnType<typeof buildTurnContext>>;
  propose(request: WriteRequest): Promise<MemoryWriteResult>;
  confirm(request: WriteRequest): Promise<MemoryWriteResult>;
}
/** The host binds this scope; callers cannot change scope through tool arguments. */
export function createMemoryAccess(
  repository: MemoryRepository,
  options: {
    scope?: string;
    observe?: (type: string, data: unknown) => void;
    onObserverError?: (error: unknown) => void;
  } = {},
): MemoryAccess {
  const notify = (type: string, data: unknown) => {
    try {
      options.observe?.(type, data);
    } catch (error) {
      options.onObserverError?.(error);
    }
  };
  const view = async () => {
    const snapshot = await repository.snapshot();
    const store = new InMemoryMemoryStore();
    for (const entry of snapshot.entries)
      if (!options.scope || !entry.scope || entry.scope === options.scope) store.add(entry);
    return { store, revision: snapshot.revision };
  };
  const write = async (request: WriteRequest, confirmed: boolean) => {
    const bound = {
      ...request,
      ...(options.scope ? { scope: options.scope } : {}),
      basis: confirmed ? ("user" as const) : ("inference" as const),
      speaker: confirmed ? ("user" as const) : ("assistant" as const),
    };
    const result = await repository.commit(bound);
    notify("memory.write", { request: bound, result });
    return result;
  };
  return {
    async search(query) {
      const { store, revision } = await view();
      const result = store.search(query);
      notify("memory.search", { query, result, revision });
      return result;
    },
    async context(task, maxChars) {
      const { store, revision } = await view();
      const result = buildTurnContext(store, task, maxChars);
      notify("context.selection", { task, revision, ...result });
      return result;
    },
    propose: (request) => write(request, false),
    confirm: (request) => write(request, true),
  };
}
