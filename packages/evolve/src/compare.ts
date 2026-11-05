import type { Signal } from "@mentat/core";

function index(signals: Signal[]): Map<string, Signal> {
  const out = new Map<string, Signal>();
  for (const signal of signals) {
    if (!signal.name || !Number.isFinite(signal.value))
      throw new Error("invalid evaluation signal");
    if (out.has(signal.name)) throw new Error(`duplicate evaluation signal: ${signal.name}`);
    out.set(signal.name, signal);
  }
  return out;
}

/** True when `a` is no worse on every metric and better on at least one. */
export function dominates(a: Signal[], b: Signal[]): boolean {
  const am = index(a);
  const bm = index(b);
  if (am.size !== bm.size) return false;
  let better = false;
  for (const [name, bs] of bm) {
    const as = am.get(name);
    if (!as || as.direction !== bs.direction) return false;
    if (as.value === bs.value) continue;
    const higherBetter = as.direction === "higher-better";
    if (as.value > bs.value !== higherBetter) return false;
    better = true;
  }
  return better;
}
