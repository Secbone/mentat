import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Digest, digestOf, type JsonValue } from "@mentat/core";
import { atomicJson } from "@mentat/storage-file";

const PREFIX = "sha256:";

/**
 * Minimal content-addressed store for data artifact payloads.
 *
 * Paths are `<root>/<sha256>.json`. Writing is idempotent: the same digest
 * always denotes the same bytes, so a re-write is a no-op check rather than a
 * mutation. Reads verify the digest, which detects disk corruption and manual
 * tampering.
 */
export class ArtifactStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  put(payload: JsonValue): Digest {
    const digest = digestOf(payload);
    const path = this.path(digest);
    if (!existsSync(path)) atomicJson(path, payload);
    return digest;
  }

  get(digest: Digest): JsonValue {
    const path = this.path(digest);
    if (!existsSync(path)) throw new Error(`artifact payload not found: ${digest}`);
    const payload = JSON.parse(readFileSync(path, "utf8")) as JsonValue;
    if (digestOf(payload) !== digest)
      throw new Error(`artifact payload digest mismatch: ${digest}`);
    return payload;
  }

  has(digest: Digest): boolean {
    return existsSync(this.path(digest));
  }

  private path(digest: Digest): string {
    if (!digest.startsWith(PREFIX)) throw new Error(`not a data artifact digest: ${digest}`);
    const hex = digest.slice(PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`invalid digest: ${digest}`);
    return join(this.dir, `${hex}.json`);
  }
}
