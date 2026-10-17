import { assert, canonical, object } from "./validation";

export interface JsonCriterion {
  path: string[];
  op: "eq" | "contains" | "lt" | "lte" | "gt" | "gte" | "absent";
  value?: unknown;
}
export interface JsonCriteria {
  all: JsonCriterion[];
  keys?: string[];
}
export function validateCriteria(value: unknown): JsonCriteria {
  const c = object(value);
  assert(Array.isArray(c.all) && c.all.length > 0, "criteria require nonempty all");
  if (c.keys !== undefined)
    assert(
      Array.isArray(c.keys) && c.keys.every((k) => typeof k === "string"),
      "invalid criteria keys",
    );
  for (const raw of c.all) {
    const rule = object(raw);
    assert(
      Array.isArray(rule.path) &&
        rule.path.every(
          (k) => typeof k === "string" && !["__proto__", "constructor", "prototype"].includes(k),
        ),
      "invalid criteria path",
    );
    assert(
      ["eq", "contains", "lt", "lte", "gt", "gte", "absent"].includes(String(rule.op)),
      "invalid criteria operator",
    );
    if (rule.op !== "absent") assert(Object.hasOwn(rule, "value"), "criterion value required");
    if (["lt", "lte", "gt", "gte"].includes(String(rule.op)))
      assert(
        typeof rule.value === "number" && Number.isFinite(rule.value),
        "numeric criterion required",
      );
  }
  return value as JsonCriteria;
}
/** Parse the whole answer: prose/code fences around a valid fragment cannot silently pass. */
export function checkJsonCriteria(answer: string, criteria: JsonCriteria): boolean {
  validateCriteria(criteria);
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    return false;
  }
  if (criteria.keys) {
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      canonical(Object.keys(value).sort()) !== canonical([...criteria.keys].sort())
    )
      return false;
  }
  return criteria.all.every((rule) => {
    let actual = value;
    for (const part of rule.path) {
      if (!actual || typeof actual !== "object" || !Object.hasOwn(actual, part)) {
        actual = undefined;
        break;
      }
      actual = (actual as Record<string, unknown>)[part];
    }
    if (rule.op === "absent") return actual === undefined;
    if (actual === undefined) return false;
    if (rule.op === "eq") return canonical(actual) === canonical(rule.value);
    if (rule.op === "contains")
      return (
        typeof actual === "string" && typeof rule.value === "string" && actual.includes(rule.value)
      );
    if (typeof actual !== "number" || !Number.isFinite(actual) || typeof rule.value !== "number")
      return false;
    if (rule.op === "lt") return actual < rule.value;
    if (rule.op === "lte") return actual <= rule.value;
    if (rule.op === "gt") return actual > rule.value;
    return actual >= rule.value;
  });
}
