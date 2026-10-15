import type { Candidate, GateResult } from "./types";

/** A checkpoint between materializing a change and evaluating it. */
export interface Gate {
  readonly name: string;
  check(candidate: Candidate): Promise<GateResult> | GateResult;
}

/** Runs gates in order; the first failure short-circuits. */
export class GateChain implements Gate {
  readonly name = "chain";

  constructor(private readonly gates: Gate[]) {}

  async check(candidate: Candidate): Promise<GateResult> {
    for (const gate of this.gates) {
      const result = await gate.check(candidate);
      if (!result.passed) return result;
    }
    return { passed: true, gate: this.name };
  }
}

export function functionGate(
  name: string,
  check: (candidate: Candidate) => boolean | GateResult,
): Gate {
  return {
    name,
    check: (candidate) => {
      const result = check(candidate);
      if (typeof result === "boolean") {
        return result
          ? { passed: true, gate: name }
          : { passed: false, gate: name, reason: "rejected" };
      }
      return result;
    },
  };
}

const matchCache = new Map<string, RegExp>();
const REGEX_SPECIALS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

/** Translate a simple glob (`**`, `*`) into an anchored regular expression. */
function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char !== undefined && REGEX_SPECIALS.has(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

/** Match a repo-relative path against a simple glob (`dir/**`, `*.ext`, exact). */
export function matchPath(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2));
  }
  if (!pattern.includes("*")) return path === pattern;
  let regex = matchCache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    matchCache.set(pattern, regex);
  }
  return regex.test(path);
}

/**
 * Reject a change that modifies any protected path. The caller supplies how to
 * discover the changed files (git, a snapshot comparison, ...).
 */
export function pathGuardGate(
  name: string,
  patterns: string[],
  changedFiles: (candidate: Candidate) => Promise<string[]> | string[],
): Gate {
  return {
    name,
    check: async (candidate) => {
      const files = await changedFiles(candidate);
      for (const file of files) {
        if (patterns.some((pattern) => matchPath(pattern, file))) {
          return { passed: false, gate: name, reason: `protected path changed: ${file}` };
        }
      }
      return { passed: true, gate: name };
    },
  };
}
