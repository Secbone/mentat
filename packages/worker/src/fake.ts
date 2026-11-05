import type {
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEvent,
  WorkerReport,
  WorkerSession,
  WorkerTask,
} from "./contract";

const CAPABILITIES: WorkerCapabilities = {
  promptInjection: "system",
  skills: "none",
  mcp: false,
  permissions: "none",
  streaming: true,
  costReporting: false,
  steer: false,
  fork: false,
};

export interface FakeWorkerOptions {
  id?: string;
  capabilities?: Partial<WorkerCapabilities>;
  report?: WorkerReport;
  events?: WorkerEvent[];
}

class FakeSession implements WorkerSession {
  readonly id: string;
  private readonly configured: WorkerEvent[];
  private readonly result: WorkerReport;
  private cancelled = false;

  constructor(id: string, events: WorkerEvent[], report: WorkerReport) {
    this.id = id;
    this.configured = events;
    this.result = report;
  }

  async send(_text: string): Promise<void> {}

  async *events(): AsyncIterable<WorkerEvent> {
    for (const event of this.configured) yield event;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async report(): Promise<WorkerReport> {
    if (this.cancelled) return { kind: "waiting", summary: "cancelled" };
    return this.result;
  }

  async dispose(): Promise<void> {}
}

/** Deterministic Worker for domain and control-plane tests. */
export class FakeWorker implements WorkerAdapter {
  readonly id: string;
  private readonly options: FakeWorkerOptions;

  constructor(options: FakeWorkerOptions = {}) {
    this.id = options.id ?? "fake";
    this.options = options;
  }

  capabilities(): WorkerCapabilities {
    return { ...CAPABILITIES, ...this.options.capabilities };
  }

  async spawn(task: WorkerTask): Promise<WorkerSession> {
    const at = new Date().toISOString();
    const events = this.options.events ?? [
      { type: "message", at, text: `started ${task.assignmentId}` },
      { type: "settled", at, reason: "done" },
    ];
    return new FakeSession(
      `fake-${task.assignmentId}`,
      events,
      this.options.report ?? { kind: "ready", summary: "fake worker finished" },
    );
  }
}
