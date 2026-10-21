import type { Signal } from "@mentat/core";

function index(signals: Signal[]): Map<string, Signal> {
  validateSignals(signals);
  return new Map(signals.map((signal) => [signal.name, signal]));
}

export function validateSignals(signals: Signal[]): void {
  if (!Array.isArray(signals) || !signals.length) throw new Error("empty evaluation signals");
  const names = new Set<string>();
  for (const signal of signals) {
    if (
      !signal ||
      typeof signal.name !== "string" ||
      !signal.name.trim() ||
      names.has(signal.name) ||
      !Number.isFinite(signal.value) ||
      !["higher-better", "lower-better"].includes(signal.direction)
    )
      throw new Error("invalid or duplicate evaluation signal");
    names.add(signal.name);
  }
}

export function assertComparableSignals(a: Signal[], b: Signal[]): void {
  const am = index(a),
    bm = index(b);
  if (am.size !== bm.size || [...bm].some(([name, s]) => am.get(name)?.direction !== s.direction))
    throw new Error("evaluation metric contract changed");
}

/** +1 if `a` is better, -1 if worse, 0 if equal, for one metric. */
function compare(a: Signal, b: Signal): number {
  if (a.value === b.value) return 0;
  const higherBetter = a.direction === "higher-better";
  const greater = a.value > b.value;
  return greater === higherBetter ? 1 : -1;
}

/**
 * Only complete vectors with identical metric names and directions can dominate.
 */
export function dominates(a: Signal[], b: Signal[]): boolean {
  const am = index(a);
  const bm = index(b);
  if (am.size !== bm.size || [...bm].some(([name, s]) => am.get(name)?.direction !== s.direction))
    return false;
  let strictlyBetter = false;
  for (const [name, bs] of bm) {
    const as = am.get(name);
    if (!as) continue;
    const cmp = compare(as, bs);
    if (cmp < 0) return false;
    if (cmp > 0) strictlyBetter = true;
  }
  return strictlyBetter;
}

/** Indices of the non-dominated members of a set of signal vectors. */
export function paretoFront(list: Signal[][]): number[] {
  const front: number[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const candidate = list[i];
    if (!candidate) continue;
    let dominated = false;
    for (let j = 0; j < list.length; j += 1) {
      if (i === j) continue;
      const other = list[j];
      if (other && dominates(other, candidate)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) front.push(i);
  }
  return front;
}

/** Scalarize signals for parent *selection* only (never for accepting changes). */
export function scoreOf(signals: Signal[]): number {
  validateSignals(signals);
  let score = 0;
  for (const signal of signals) {
    score += signal.direction === "higher-better" ? signal.value : -signal.value;
  }
  return score;
}
