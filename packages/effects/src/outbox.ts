import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicJson, withFileLock } from "@mentat/storage-file";
import { type EffectQueue, Later } from "./queue";

export type ReplyPurpose = "acknowledgement" | "answer" | "result" | "attention";
export type ReceiptStatus = "waiting" | "sent" | "failed" | "dropped";

export interface OutboxMessage {
  ticket?: string;
  channel: string;
  purpose: ReplyPurpose;
  text: string;
}

export interface OutboxReceipt extends OutboxMessage {
  id: string;
  status: ReceiptStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface OutboxTransport {
  send(message: OutboxMessage): Promise<"sent" | "gone">;
}

export interface OutboxOptions {
  path: string;
  now?: () => Date;
  id?: () => string;
}

/**
 * Durable outbound messages. A send stores a receipt and enqueues a `reply`
 * effect; the effect sends through the Source's Channel and settles the
 * receipt. Messages for one Ticket/conversation keep their order.
 */
export class Outbox {
  readonly path: string;
  private readonly queue: EffectQueue;
  private readonly transport: OutboxTransport;
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private receiptsById: Map<string, OutboxReceipt>;

  constructor(queue: EffectQueue, transport: OutboxTransport, options: OutboxOptions) {
    this.queue = queue;
    this.transport = transport;
    this.path = options.path;
    this.clock = options.now ?? (() => new Date());
    this.nextId = options.id ?? (() => crypto.randomUUID());
    mkdirSync(dirname(this.path), { recursive: true });
    this.receiptsById = new Map(this.load().map((receipt) => [receipt.id, receipt]));
    this.queue.handle("reply", async (payload) => {
      const id = (payload as { id?: unknown }).id;
      if (typeof id !== "string") throw new Error("reply effect has no receipt id");
      await this.deliver(id);
    });
  }

  private load(): OutboxReceipt[] {
    if (!existsSync(this.path)) return [];
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("invalid outbox: not an array");
    return raw as OutboxReceipt[];
  }

  private persist(): void {
    withFileLock(`${this.path}.lock`, () => atomicJson(this.path, [...this.receiptsById.values()]));
  }

  receipts(): OutboxReceipt[] {
    return [...this.receiptsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  send(message: OutboxMessage): OutboxReceipt {
    const now = this.clock().toISOString();
    const receipt: OutboxReceipt = {
      ...message,
      id: this.nextId(),
      status: "waiting",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.receiptsById.set(receipt.id, receipt);
    this.persist();
    this.queue.enqueue("reply", receipt.id, { id: receipt.id });
    return { ...receipt };
  }

  private async deliver(id: string): Promise<void> {
    const receipt = this.receiptsById.get(id);
    if (!receipt || receipt.status === "sent" || receipt.status === "dropped") return;
    const earlier = this.receipts().find(
      (candidate) =>
        candidate.id !== receipt.id &&
        candidate.status === "waiting" &&
        candidate.ticket === receipt.ticket &&
        candidate.channel === receipt.channel &&
        candidate.createdAt < receipt.createdAt,
    );
    if (earlier) throw new Later(`waiting behind ${earlier.id}`);
    receipt.attempts += 1;
    receipt.updatedAt = this.clock().toISOString();
    this.persist();
    try {
      const result = await this.transport.send({
        ...(receipt.ticket ? { ticket: receipt.ticket } : {}),
        channel: receipt.channel,
        purpose: receipt.purpose,
        text: receipt.text,
      });
      receipt.status = result === "sent" ? "sent" : "dropped";
      delete receipt.lastError;
    } catch (error) {
      receipt.status = "waiting";
      receipt.lastError = error instanceof Error ? error.message : String(error);
      this.persist();
      throw error;
    }
    receipt.updatedAt = this.clock().toISOString();
    this.persist();
  }
}
