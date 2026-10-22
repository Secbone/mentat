import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { IterationReceipt } from "@mentat/evolution";
import { withFileLock } from "@mentat/storage-file";

/**
 * Append-only evidence log for loop iterations. Receipts are the source of
 * truth for "what changed, under which protocol, with which signals"; derived
 * reports should read them instead of re-deriving from stdout.
 */
export class ReceiptStore {
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, "receipts.jsonl");
  }

  append(receipt: IterationReceipt): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(receipt)}\n`;
    withFileLock(`${this.path}.lock`, () => {
      const fd = openSync(this.path, "a", 0o600);
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  }

  read(): IterationReceipt[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as IterationReceipt;
        } catch (error) {
          throw new Error(`corrupt receipt at ${this.path}:${index + 1}`, { cause: error });
        }
      });
  }
}
