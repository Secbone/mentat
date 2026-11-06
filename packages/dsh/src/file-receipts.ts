import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReceiptStore, RuntimeReceipt } from "./runtime";

/** Append-only JSONL receipt sink. */
export class FileReceiptSink implements ReceiptStore {
  constructor(readonly path: string) {}

  append(receipt: RuntimeReceipt): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  }

  list(): RuntimeReceipt[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as RuntimeReceipt;
        } catch {
          throw new Error(`invalid receipt at ${this.path}:${index + 1}`);
        }
      });
  }
}
