import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileTrajectoryStore,
  inspectTrajectory,
  readTrajectory,
  resolveEventData,
} from "./trajectory";

const dir = () => mkdtempSync(join(tmpdir(), "mentat-trajectory-"));
describe("durable trajectory", () => {
  it("stores large payloads losslessly and resolves redacted artifacts", async () => {
    const path = dir(),
      store = new FileTrajectoryStore(path, { artifactThreshold: 20 });
    const output = "result ".repeat(3000);
    store.emit("tool.result", {
      output,
      apiKey: "secret-value",
      authorization: "Bearer credential",
    });
    await store.close();
    const events = readTrajectory(path);
    const first = events[0];
    if (!first) throw Error("missing event");
    expect(resolveEventData(path, first)).toEqual({
      output,
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
    });
    expect(readFileSync(join(path, "events.jsonl"), "utf8")).not.toContain("secret-value");
  });
  it("keeps already-written events visible before close", () => {
    const path = dir(),
      store = new FileTrajectoryStore(path);
    store.emit("turn.start", { turnId: "t" });
    expect(readTrajectory(path)).toHaveLength(1);
    expect(inspectTrajectory(path)).toMatchObject({
      status: "running",
      violations: ["turn t: 0 terminal events"],
    });
    return store.close("incomplete");
  });
  it("reports a torn tail rather than silently discarding it", async () => {
    const path = dir(),
      store = new FileTrajectoryStore(path);
    store.emit("start");
    await store.close();
    appendFileSync(join(path, "events.jsonl"), "{partial");
    expect(inspectTrajectory(path).gaps).toBe(1);
  });
  it("records capacity gaps and rejects a second writer", async () => {
    const path = dir(),
      store = new FileTrajectoryStore(path, { maxBytes: 4 });
    expect(() => new FileTrajectoryStore(path)).toThrow();
    store.emit("large", { text: "large" });
    await store.close();
    expect(inspectTrajectory(path)).toMatchObject({ status: "incomplete", gaps: 1 });
  });
  it("identifies orphan tool results", async () => {
    const path = dir(),
      store = new FileTrajectoryStore(path);
    store.emit("agent.event", { turnId: "t", type: "tool.result", id: "missing" });
    store.emit("turn.end", { turnId: "t" });
    await store.close();
    expect(inspectTrajectory(path).violations).toContain("orphan tool result: missing");
  });
});

it("preserves externally appended event identities and enforces their sequence", async () => {
  const path = dir(),
    store = new FileTrajectoryStore(path);
  const event = {
    schemaVersion: 1 as const,
    eventId: "original",
    seq: 0,
    traceId: store.traceId,
    ts: 123,
    type: "imported",
  };
  await store.append([event]);
  await expect(store.append([event])).rejects.toThrow("sequence mismatch");
  await store.close();
  expect(readTrajectory(path)[0]).toEqual(event);
});
