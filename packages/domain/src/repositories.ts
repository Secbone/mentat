import type {
  Assignment,
  Channel,
  Decision,
  Eval,
  Input,
  Mandate,
  ReplyRequest,
  Thread,
  Ticket,
  Trigger,
} from "./types";

/** One collection of domain records. Implementations own durability. */
export interface Repository<T> {
  get(id: string): T | undefined;
  save(value: T): void;
  list(): T[];
}

export interface Repositories {
  triggers: Repository<Trigger>;
  threads: Repository<Thread>;
  evals: Repository<Eval>;
  decisions: Repository<Decision>;
  tickets: Repository<Ticket>;
  mandates: Repository<Mandate>;
  assignments: Repository<Assignment>;
  inputs: Repository<Input>;
  channels: Repository<Channel>;
  replies: Repository<ReplyRequest>;
}

class MemoryRepository<T extends { id: string }> implements Repository<T> {
  private readonly rows = new Map<string, T>();

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  save(value: T): void {
    this.rows.set(value.id, value);
  }

  list(): T[] {
    return [...this.rows.values()];
  }
}

/** In-memory repositories for domain tests and deterministic simulations. */
export class InMemoryRepositories implements Repositories {
  readonly triggers = new MemoryRepository<Trigger>();
  readonly threads = new MemoryRepository<Thread>();
  readonly evals = new MemoryRepository<Eval>();
  readonly decisions = new MemoryRepository<Decision>();
  readonly tickets = new MemoryRepository<Ticket>();
  readonly mandates = new MemoryRepository<Mandate>();
  readonly assignments = new MemoryRepository<Assignment>();
  readonly inputs = new MemoryRepository<Input>();
  readonly channels = new MemoryRepository<Channel>();
  readonly replies = new MemoryRepository<ReplyRequest>();
}
