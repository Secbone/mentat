import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ReceiptSink, RuntimeReceipt } from "./runtime";

/** Append-only JSONL receipt sink. */
export class FileReceiptSink implements ReceiptSink {
  constructor(readonly path: string) {}

  append(receipt: RuntimeReceipt): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  }
}
