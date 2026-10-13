import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlTracer } from "./trace";

describe("JsonlTracer", () => {
  it("appends one JSON line per event with metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-trace-"));
    const path = join(dir, "nested", "trace.jsonl");
    const tracer = new JsonlTracer(path, { runId: "r1" });
    tracer.emit("loop.start", { root: "x" });
    tracer.emit("loop.end");

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? "{}") as {
      type?: string;
      runId?: string;
      data?: unknown;
    };
    expect(first.type).toBe("loop.start");
    expect(first.runId).toBe("r1");
    expect(first.data).toEqual({ root: "x" });

    const second = JSON.parse(lines[1] ?? "{}") as { type?: string; data?: unknown };
    expect(second.type).toBe("loop.end");
    expect(second.data).toBeUndefined();
  });
});
