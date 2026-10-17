import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePlan } from "@mentat/benchmark";
import { describe, expect, it } from "vitest";
import { runExternal } from "./external";
import { renderReport, trendsCsv } from "./report";
import { createRunDirectory, history, makeRun, readResultInput, readRun, saveRun } from "./storage";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../benchmarks/examples/${name}.json`, import.meta.url), "utf8"),
  );
const temp = () => mkdtempSync(join(tmpdir(), "mentat-benchmark-"));
describe("immutable benchmark records", () => {
  it("roundtrips source and result with hashes, and refuses overwrite/corruption", () => {
    const out = join(temp(), "run"),
      p = validatePlan(fixture("harbor-plan")),
      source = fixture("harbor-trials");
    const run = makeRun(p, source, "harbor-trials-v1");
    createRunDirectory(out, p);
    saveRun(out, run, source);
    expect(readRun(out)).toEqual(run);
    expect(() => createRunDirectory(out, p)).toThrow();
    expect(() => saveRun(out, run, source)).toThrow();
    writeFileSync(join(out, "source.json"), "[]");
    expect(() => readRun(out)).toThrow("integrity");
  });
  it("reads per-trial Harbor directories, never the aggregate mean", () => {
    const root = temp();
    writeFileSync(join(root, "result.json"), JSON.stringify({ mean: 1 }));
    for (const raw of fixture("harbor-trials")) {
      mkdirSync(join(root, raw.trial_name));
      writeFileSync(join(root, raw.trial_name, "result.json"), JSON.stringify(raw));
    }
    expect(readResultInput(root, "harbor-trials-v1")).toEqual(fixture("harbor-trials"));
    expect(() => readResultInput(root, "inspect-json-v1")).toThrow("directory");
  });
  it("keeps incomplete attempts visible and emits separate compatibility cohorts", () => {
    const root = temp(),
      p = validatePlan(fixture("harbor-plan")),
      input = fixture("harbor-trials");
    createRunDirectory(join(root, "incomplete"), p);
    const run = makeRun(p, input, "harbor-trials-v1");
    createRunDirectory(join(root, "done"), p);
    saveRun(join(root, "done"), run, input);
    const records = history(root);
    expect(records.filter((r) => r.error)).toHaveLength(1);
    const other = structuredClone(run);
    other.plan.scorer.revision = "2";
    const csv = trendsCsv([run, other]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]?.split(",")[4]).not.toBe(lines[2]?.split(",")[4]);
    expect(renderReport(run)).toContain("unknown 1");
    expect(renderReport(run)).toContain("Track: smoke");
  });
});

describe("delegating upstream execution", () => {
  it("runs argv directly and imports retained per-trial results", async () => {
    const root = temp(),
      script = join(root, "upstream.mjs");
    writeFileSync(
      script,
      'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], process.argv[3]);',
    );
    const out = join(root, "run"),
      p = validatePlan(fixture("harbor-plan"));
    const result = await runExternal(
      p,
      {
        command: process.execPath,
        args: [script, "{runDir}/upstream.json", JSON.stringify(fixture("harbor-trials"))],
        cwd: root,
        timeoutMs: 5000,
        adapter: "harbor-trials-v1",
        resultPath: "{runDir}/upstream.json",
      },
      out,
    );
    expect(result.ok).toBe(true);
    expect(readRun(out).results).toHaveLength(2);
    expect(readFileSync(join(out, "events.jsonl"), "utf8")).toContain("external.end");
  });
  it("retains a failed external process as a failed run with missing planned units", async () => {
    const root = temp(),
      out = join(root, "failed");
    const result = await runExternal(
      validatePlan(fixture("harbor-plan")),
      {
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: root,
        timeoutMs: 5000,
        adapter: "harbor-trials-v1",
        resultPath: "{runDir}/not-created.json",
      },
      out,
    );
    expect(result.ok).toBe(false);
    expect(result.run.provenance.execution).toBe("failed");
    expect(readRun(out).results.every((r) => r.status === "missing")).toBe(true);
  });
  it("rejects stale output paths and unsupported adapters before executing anything", async () => {
    const root = temp(),
      job = {
        command: process.execPath,
        args: [],
        cwd: root,
        timeoutMs: 5000,
        adapter: "harbor-trials-v1",
        resultPath: join(root, "old.json"),
      };
    await expect(
      runExternal(validatePlan(fixture("harbor-plan")), job, join(root, "out")),
    ).rejects.toThrow("fresh run");
    await expect(
      runExternal(
        validatePlan(fixture("harbor-plan")),
        { ...job, adapter: "invented" },
        join(root, "out"),
      ),
    ).rejects.toThrow("unknown result adapter");
  });
  it("does not accept exit zero with an incomplete or ungraded evaluation as success", async () => {
    const root = temp(),
      script = join(root, "partial.mjs"),
      input = fixture("harbor-trials");
    input.pop();
    input[0].verifier_result = null;
    writeFileSync(
      script,
      'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], process.argv[3]);',
    );
    const result = await runExternal(
      validatePlan(fixture("harbor-plan")),
      {
        command: process.execPath,
        args: [script, "{runDir}/partial.json", JSON.stringify(input)],
        cwd: root,
        timeoutMs: 5000,
        adapter: "harbor-trials-v1",
        resultPath: "{runDir}/partial.json",
      },
      join(root, "run"),
    );
    expect(result.ok).toBe(false);
    expect(result.run.results.map((r) => r.status)).toEqual(["completed", "missing"]);
    expect(result.run.results[0]?.metrics["task.success"]?.value).toBeNull();
  });
});
