import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("SWE result publication boundary", () => {
  it("does not publish an empty replay's zero as a model attempt that never started", () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-swe-export-"));
    const source = join(root, "pilot");
    mkdirSync(source);
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({
        upstreamRevision: "66f92766bba642462d4bbe5479e83f91f9211862",
        subjectRevision: "fixture-1",
        subjectDiffSha256: "0".repeat(64),
        bridgeFiles: {},
        model: "fixture-model",
        timeoutMs: 10000,
        maxSteps: 10,
        selection: "fixture",
        tasks: { a: { files: {} }, b: { files: {} } },
        ids: ["a", "b"],
      }),
    );
    const trial = join(source, "jobs/trial/result.json");
    const host = join(source, "jobs/trial/agent/host");
    mkdirSync(host, { recursive: true });
    writeFileSync(
      join(host, "response.json"),
      JSON.stringify({
        result: { reason: "done" },
        sourceIdentity: { revision: "fixture-1", codeSha256: "1".repeat(64) },
        observations: { models: [{ effective: "fixture-model" }], costUsd: 0.01 },
      }),
    );
    writeFileSync(
      join(source, "results.json"),
      JSON.stringify({
        status: "completed",
        cases: [
          { id: "a", status: "completed", reward: 0, stages: {} },
          {
            id: "b",
            status: "completed",
            reward: 1,
            stages: {
              oracle: { status: "completed", reward: 1 },
              empty: { status: "completed", reward: 0 },
              mentat: { trial, elapsedSeconds: 2 },
              regrade: { status: "completed", reward: 1 },
            },
          },
        ],
      }),
    );
    const destination = join(root, "unified");
    execFileSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/swe-bench-export.ts"), source, destination],
      { cwd: resolve(".") },
    );
    const run = JSON.parse(readFileSync(join(destination, "run.json"), "utf8"));
    expect(run.results[0]).toMatchObject({
      status: "error",
      metrics: { "task.resolved": { value: null } },
    });
    expect(run.results[1]).toMatchObject({
      status: "completed",
      metrics: { "task.resolved": { value: 1 } },
      costUsd: 0.01,
    });
    const responsePath = join(host, "response.json");
    const failed = JSON.parse(readFileSync(responsePath, "utf8"));
    failed.result.reason = "error";
    writeFileSync(responsePath, JSON.stringify(failed));
    const invalidDestination = join(root, "transport-error");
    execFileSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/swe-bench-export.ts"), source, invalidDestination],
      { cwd: resolve(".") },
    );
    const invalid = JSON.parse(readFileSync(join(invalidDestination, "run.json"), "utf8"));
    expect(invalid.results[1]).toMatchObject({
      status: "error",
      metrics: { "task.resolved": { value: null } },
    });
    // Budget exhaustion is an execution result, independent of patch quality.
    failed.result = {
      reason: "length",
      termination: { cause: "request-limit", source: "acp", rawReason: "max_turn_requests" },
      completion: { response: "present", verification: "unverified", warnings: [] },
    };
    writeFileSync(responsePath, JSON.stringify(failed));
    const limitedDestination = join(root, "limited-but-verified");
    execFileSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/swe-bench-export.ts"), source, limitedDestination],
      { cwd: resolve(".") },
    );
    const limited = JSON.parse(readFileSync(join(limitedDestination, "run.json"), "utf8"));
    expect(limited.results[1]).toMatchObject({
      status: "completed",
      metrics: { "task.resolved": { value: 1 } },
      observations: {
        subjectOutcome: "length",
        subjectTermination: failed.result.termination,
        subjectCompletion: failed.result.completion,
      },
    });
  });
});
