import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SourceState } from "@mentat/domain";
import { atomicJson, withFileLock } from "@mentat/storage-file";

/** JSON read position and source metadata under a file lock. */
export class FileSourceState implements SourceState {
  private values: Record<string, unknown>;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.values = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
      : {};
  }

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.values[key] = value;
    withFileLock(`${this.path}.lock`, () => atomicJson(this.path, this.values));
  }
}

export class MemorySourceState implements SourceState {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}
