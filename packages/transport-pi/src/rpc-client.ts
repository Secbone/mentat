import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface RpcRecord {
  [key: string]: unknown;
}

export interface RpcClientOptions {
  binary: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onRecord: (record: RpcRecord) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (code: number | null) => void;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Long-lived `pi --mode rpc` child. Framing is strict JSONL split on LF only
 * (never readline, which also splits on U+2028/U+2029).
 */
export class RpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;

  constructor(options: RpcClientOptions) {
    this.child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.handleChunk(chunk, options.onRecord);
    });

    if (options.onStderr) {
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", options.onStderr);
    }

    this.child.on("exit", (code) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("pi process exited"));
      }
      this.pending.clear();
      options.onExit?.(code);
    });

    this.child.on("error", (error) => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  private handleChunk(chunk: string, onRecord: (record: RpcRecord) => void): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      index = this.buffer.indexOf("\n");
      if (!line) continue;

      let record: RpcRecord;
      try {
        record = JSON.parse(line) as RpcRecord;
      } catch {
        continue;
      }

      if (record.type === "response" && typeof record.id === "string") {
        const pending = this.pending.get(record.id);
        if (pending) {
          this.pending.delete(record.id);
          if (record.success === false) {
            pending.reject(new Error(String(record.error ?? "pi command failed")));
          } else {
            pending.resolve(record.data);
          }
          continue;
        }
      }
      onRecord(record);
    }
  }

  request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = `mentat-${++this.nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, type, ...payload });
    });
  }

  write(record: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
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
