import type { JsonValue } from "./types";

const secretKey =
  /^(authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|set-cookie|.*_(?:api_key|access_token|refresh_token|password|secret))$/i;
export function redact(value: unknown): JsonValue {
  if (typeof value === "string")
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
      .replace(
        /((?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[REDACTED]",
      );
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        secretKey.test(key) ? "[REDACTED]" : redact(v),
      ]),
    );
  return typeof value === "number" && !Number.isFinite(value)
    ? null
    : ((value ?? null) as JsonValue);
}
