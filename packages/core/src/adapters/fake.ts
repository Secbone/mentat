import type {
  AdapterDeps,
  HarnessAdapter,
  HarnessCapabilities,
  SendOptions,
  SessionHandle,
  SessionOptions,
  UserInput,
} from "../adapter";
import type {
  AgentEvent,
  AgentEventListener,
  Message,
  PermissionDecision,
  PermissionRequest,
} from "../events";

export interface FakeAdapterOptions {
  id?: string;
  label?: string;
  capabilities?: Partial<HarnessCapabilities>;
  /** Produce the streamed deltas for a given input. */
  script?: (input: UserInput) => string[];
}

const DEFAULT_CAPABILITIES: HarnessCapabilities = {
  steer: false,
  compact: false,
  fork: false,
  permissions: true,
};

function defaultScript(input: UserInput): string[] {
  const words = `fake: ${input.text}`.split(/(\s+)/);
  return words.filter((part) => part.length > 0);
}

class FakeSession implements SessionHandle {
  readonly id: string;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly script: (input: UserInput) => string[];
  private readonly deps: AdapterDeps;
  private aborted = false;
  private disposed = false;

  constructor(id: string, script: (input: UserInput) => string[], deps: AdapterDeps) {
    this.id = id;
    this.script = script;
    this.deps = deps;
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async send(input: UserInput, _options?: SendOptions): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    this.emit({ type: "run.started", sessionId: this.id });

    const parts: string[] = [];
    for (const delta of this.script(input)) {
      if (this.aborted) break;
      await Promise.resolve();
      parts.push(delta);
      this.emit({ type: "message.delta", sessionId: this.id, text: delta });
    }

    if (this.aborted) {
      this.aborted = false;
      this.emit({ type: "run.settled", sessionId: this.id, reason: "aborted" });
      return;
    }

    const message: Message = { role: "assistant", text: parts.join("") };
    this.emit({ type: "message.completed", sessionId: this.id, message });
    this.emit({
      type: "usage",
      sessionId: this.id,
      usage: { inputTokens: input.text.length, outputTokens: message.text.length },
    });
    this.emit({ type: "run.settled", sessionId: this.id, reason: "done" });
  }

  /** Ask the injected permission handler; used by tests of the permission bridge. */
  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (!this.deps.onPermission) return "allow";
    return this.deps.onPermission.request(request);
  }

  async interrupt(): Promise<void> {
    this.aborted = true;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
  }
}

let sessions = 0;

export function createFakeAdapter(options: FakeAdapterOptions = {}): HarnessAdapter {
  const script = options.script ?? defaultScript;
  const capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  return {
    id: options.id ?? "fake",
    label: options.label ?? "Fake",
    capabilities: () => capabilities,
    createSession: async (_options: SessionOptions, deps: AdapterDeps = {}) => {
      if (_options.executionPolicy) throw new Error("Fake adapter cannot enforce execution policy");
      return new FakeSession(`fake-${++sessions}`, script, deps);
    },
  };
}
