import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Assignment,
  Channel,
  Decision,
  Eval,
  Input,
  Mandate,
  ReplyRequest,
  Repositories,
  Repository,
  Thread,
  Ticket,
  Trigger,
} from "@mentat/domain";
import { atomicJson, withFileLock } from "@mentat/storage-file";

interface State {
  triggers: Trigger[];
  threads: Thread[];
  evals: Eval[];
  decisions: Decision[];
  tickets: Ticket[];
  mandates: Mandate[];
  assignments: Assignment[];
  inputs: Input[];
  channels: Channel[];
  replies: ReplyRequest[];
}

function empty(): State {
  return {
    triggers: [],
    threads: [],
    evals: [],
    decisions: [],
    tickets: [],
    mandates: [],
    assignments: [],
    inputs: [],
    channels: [],
    replies: [],
  };
}

type Key = keyof State;

class FileRepository<T extends { id: string }> implements Repository<T> {
  constructor(
    private readonly owner: FileRepositories,
    private readonly key: Key,
  ) {}

  get(id: string): T | undefined {
    return (this.owner.state[this.key] as unknown as T[]).find((row) => row.id === id);
  }

  save(value: T): void {
    const rows = this.owner.state[this.key] as unknown as T[];
    const index = rows.findIndex((row) => row.id === value.id);
    if (index >= 0) rows[index] = value;
    else rows.push(value);
    this.owner.persist();
  }

  list(): T[] {
    return [...(this.owner.state[this.key] as unknown as T[])];
  }
}

/**
 * Durable repositories backed by one atomically replaced JSON file.
 *
 * One Engine process is the writer, so a full snapshot per command is enough;
 * the file lock prevents two processes from replacing the same state. Move to
 * SQLite when concurrent readers or large histories matter.
 */
export class FileRepositories implements Repositories {
  readonly dir: string;
  readonly path: string;
  state: State;
  readonly triggers: Repository<Trigger>;
  readonly threads: Repository<Thread>;
  readonly evals: Repository<Eval>;
  readonly decisions: Repository<Decision>;
  readonly tickets: Repository<Ticket>;
  readonly mandates: Repository<Mandate>;
  readonly assignments: Repository<Assignment>;
  readonly inputs: Repository<Input>;
  readonly channels: Repository<Channel>;
  readonly replies: Repository<ReplyRequest>;

  constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    this.state = this.load();
    this.triggers = new FileRepository(this, "triggers");
    this.threads = new FileRepository(this, "threads");
    this.evals = new FileRepository(this, "evals");
    this.decisions = new FileRepository(this, "decisions");
    this.tickets = new FileRepository(this, "tickets");
    this.mandates = new FileRepository(this, "mandates");
    this.assignments = new FileRepository(this, "assignments");
    this.inputs = new FileRepository(this, "inputs");
    this.channels = new FileRepository(this, "channels");
    this.replies = new FileRepository(this, "replies");
  }

  private load(): State {
    if (!existsSync(this.path)) return empty();
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<State>;
    const state = empty();
    for (const key of Object.keys(state) as Key[]) {
      const value = raw[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw new Error(`invalid store: ${key} is not an array`);
      (state[key] as unknown[]) = value;
    }
    return state;
  }

  persist(): void {
    withFileLock(`${this.path}.lock`, () => atomicJson(this.path, this.state));
  }
}
