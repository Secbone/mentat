import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AdapterDeps } from "@mentat/core";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface AcpConnectionOptions {
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onDiagnostic?: AdapterDeps["onDiagnostic"];
  onProtocol?: AdapterDeps["onProtocol"];
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onRequest: (id: number | string, method: string, params: Record<string, unknown>) => void;
  onExit: (code: number | null) => void;
}

/**
 * Minimal newline-delimited JSON-RPC client for an Agent Client Protocol
 * child process. Framing is strict LF only (never readline, which also
 * splits on U+2028/U+2029).
 */
export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private nextId = 0;
  private closed = false;

  constructor(private readonly options: AcpConnectionOptions) {
    this.child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleChunk(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      options.onDiagnostic?.({ code: "ACP_STDERR", message: chunk });
    });

    this.child.on("exit", (code) => {
      this.closed = true;
      this.rejectAll(new Error("ACP agent exited"));
      options.onExit(code);
    });
    this.child.on("error", (error) => {
      this.closed = true;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      index = this.buffer.indexOf("\n");
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onDiagnostic?.({ code: "ACP_MALFORMED_FRAME", message: line });
      return;
    }
    this.options.onProtocol?.({ direction: "in", data: parsed });
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    const method = record.method;
    const id = record.id;

    if (typeof method === "string") {
      const params = (
        record.params && typeof record.params === "object" ? record.params : {}
      ) as Record<string, unknown>;
      if (typeof id === "number" || typeof id === "string") {
        this.options.onRequest(id, method, params);
      } else {
        this.options.onNotification(method, params);
      }
      return;
    }

    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ("error" in record) {
      const error = record.error as { message?: unknown } | undefined;
      const message = typeof error?.message === "string" ? error.message : "ACP request failed";
      pending.reject(new Error(message));
      return;
    }
    const result =
      record.result && typeof record.result === "object"
        ? (record.result as Record<string, unknown>)
        : {};
    pending.resolve(result);
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(record: Record<string, unknown>): void {
    this.options.onProtocol?.({ direction: "out", data: record });
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("ACP connection closed"));
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}
