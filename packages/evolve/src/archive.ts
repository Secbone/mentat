import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicJson, withFileLock } from "@mentat/storage-file";
import type { PackCandidate } from "./types";

/**
 * Append-only pack archive. Every candidate, accepted or not, is a stepping
 * stone; the accepted set is a view, not a replacement.
 */
export class PackArchive {
  private readonly rows = new Map<string, PackCandidate>();
  private readonly order: string[] = [];
  private readonly path?: string;

  constructor(path?: string) {
    if (path) {
      this.path = path;
      mkdirSync(dirname(path), { recursive: true });
      for (const row of this.load()) {
        this.rows.set(row.id, row);
        this.order.push(row.id);
      }
    }
  }

  private load(): PackCandidate[] {
    if (!this.path || !existsSync(this.path)) return [];
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("invalid pack archive: not an array");
    return raw as PackCandidate[];
  }

  private persist(): void {
    const path = this.path;
    if (!path) return;
    withFileLock(`${path}.lock`, () =>
      atomicJson(
        path,
        this.order.map((id) => this.rows.get(id)),
      ),
    );
  }

  add(candidate: PackCandidate): PackCandidate {
    if (this.rows.has(candidate.id)) throw new Error("duplicate pack candidate id");
    this.rows.set(candidate.id, candidate);
    this.order.push(candidate.id);
    this.persist();
    return candidate;
  }

  get(id: string): PackCandidate | undefined {
    return this.rows.get(id);
  }

  list(): PackCandidate[] {
    return this.order
      .map((id) => this.rows.get(id))
      .filter((row): row is PackCandidate => row !== undefined);
  }

  accepted(): PackCandidate[] {
    return this.list().filter((row) => row.status === "accepted");
  }

  latest(): PackCandidate | undefined {
    return this.list().at(-1);
  }
}
