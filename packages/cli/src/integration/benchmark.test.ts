import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readRun } from "@mentat/benchmark-file";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = (args: string[]) =>
  exec(process.execPath, ["--import", "tsx", "packages/cli/src/bin.ts", "bench", ...args], {
    cwd: resolve("."),
    timeout: 30000,
  });
describe("benchmark CLI and real host assembly", () => {
  it("lists selected public suites with explicit bridge readiness", async () => {
    const { stdout } = await cli(["list", "--json"]),
      catalog = JSON.parse(stdout);
    expect(catalog.benchmarks.find((b: { id: string }) => b.id === "past-bench").integration).toBe(
      "upstream-bridge-required",
    );
    expect(catalog.adapters).toHaveLength(3);
  }, 30_000);
  it("runs fresh host sessions, saves typed constraints and isolates reset/persistent states", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "mentat-bench-cli-")), "run");
    await cli([
      "run",
      "--plan",
      "benchmarks/examples/native-plan.json",
      "--dataset",
      "benchmarks/examples/episodes.json",
      "--out",
      out,
    ]);
    const run = readRun(out);
    expect(run.results).toHaveLength(8);
    expect(run.plan.subject.codeSha256).not.toBe("0".repeat(64));
    const trials = readdirSync(join(out, "trials")).map((id) => join(out, "trials", id));
    const before = trials.map((path) =>
      JSON.parse(readFileSync(join(path, "memory-before.json"), "utf8")),
    );
    const after = trials.map((path) =>
      JSON.parse(readFileSync(join(path, "memory-after.json"), "utf8")),
    );
    expect(before.filter((entries) => entries.length > 0)).toHaveLength(2);
    expect(after.flat().some((entry: { kind: string }) => entry.kind === "constraint")).toBe(true);
    const { stdout } = await cli([
      "arms",
      "--run",
      out,
      "--baseline",
      "reset",
      "--treatment",
      "explicit",
    ]);
    expect(JSON.parse(stdout).comparable).toBe(true);
    await expect(
      cli([
        "run",
        "--plan",
        "benchmarks/examples/native-plan.json",
        "--dataset",
        "benchmarks/examples/episodes.json",
        "--out",
        out,
      ]),
    ).rejects.toThrow();
  }, 30_000);
  it("imports both upstream contracts, reports coverage and refuses cross-benchmark comparison", async () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-bench-import-"));
    for (const [adapter, name, input] of [
      ["harbor-trials-v1", "harbor", "harbor-trials"],
      ["inspect-json-v1", "inspect", "inspect-log"],
    ] as const) {
      await cli([
        "import",
        "--plan",
        `benchmarks/examples/${name}-plan.json`,
        "--adapter",
        adapter,
        "--input",
        `benchmarks/examples/${input}.json`,
        "--out",
        join(root, name),
      ]);
    }
    const { stdout } = await cli(["history", "--root", root, "--csv"]);
    expect(stdout).toContain("contract-harbor");
    expect(stdout).toContain("contract-inspect");
    await expect(
      cli(["compare", "--before", join(root, "harbor"), "--after", join(root, "inspect")]),
    ).rejects.toMatchObject({ code: 2 });
    await expect(cli(["list", "--oops", "x"])).rejects.toMatchObject({ code: 1 });
  }, 30_000);
});
