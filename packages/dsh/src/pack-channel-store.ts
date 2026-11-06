import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PackChannel, type PackChannelSnapshot } from "@mentat/evolve";
import type { CapabilityPack } from "@mentat/pack";

/** Load the durable stable/canary channel, falling back to the initial pack. */
export function loadPackChannel(path: string, fallback: CapabilityPack): PackChannel {
  const snapshot = readSnapshot(path);
  return new PackChannel({
    stable: snapshot?.stable ?? fallback,
    ...(snapshot?.canary ? { canary: snapshot.canary } : {}),
    canaryRatio: snapshot?.canaryRatio ?? 0.1,
    previous: snapshot?.previous ?? [],
    onChange: (state) => writeSnapshot(path, state),
  });
}

function readSnapshot(path: string): PackChannelSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`invalid pack channel snapshot: ${path}`);
  const data = raw as Partial<PackChannelSnapshot>;
  if (!data.stable || typeof data.stable !== "object" || typeof data.stable.digest !== "string")
    throw new Error(`invalid pack channel snapshot: ${path}`);
  return {
    stable: data.stable,
    ...(data.canary ? { canary: data.canary } : {}),
    canaryRatio: typeof data.canaryRatio === "number" ? data.canaryRatio : 0.1,
    previous: Array.isArray(data.previous) ? data.previous : [],
  };
}

function writeSnapshot(path: string, snapshot: PackChannelSnapshot): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}
