import type { JsonValue } from "./types";

/**
 * Pull the first JSON array/object out of model output (handles ``` fences).
 * Shared by domain packages (data-artifact proposers, memory reflection) that
 * parse an agent's free-form reply back into structured data.
 */
export function extractJson(text: string): JsonValue {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found in model output");
  const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
  if (end < start) throw new Error("unterminated JSON in model output");
  return JSON.parse(body.slice(start, end + 1)) as JsonValue;
}
