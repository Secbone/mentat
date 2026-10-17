#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Uses only the built-in fake harness and synthetic schema fixtures. No model/network calls.
const root = resolve(process.argv[2] ?? `.mentat/benchmarks/smoke-${Date.now()}`);
mkdirSync(dirname(root), { recursive: true });
mkdirSync(root, { recursive: false });
function cli(args) {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "packages/cli/src/bin.ts", "bench", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
for (const name of ["before", "after"]) {
  cli([
    "run",
    "--plan",
    "benchmarks/examples/native-plan.json",
    "--dataset",
    "benchmarks/examples/episodes.json",
    "--out",
    join(root, name),
  ]);
}
for (const [adapter, name, input] of [
  ["harbor-trials-v1", "harbor", "harbor-trials"],
  ["inspect-json-v1", "inspect", "inspect-log"],
]) {
  cli([
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
const comparison = JSON.parse(
  cli(["compare", "--before", join(root, "before"), "--after", join(root, "after")]),
);
if (!comparison.comparable || comparison.metrics.some((m) => m.delta !== 0))
  throw new Error("identical smoke runs must be comparable with zero score delta");
writeFileSync(join(root, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`, {
  flag: "wx",
});
writeFileSync(join(root, "trends.csv"), cli(["history", "--root", root, "--csv"]), { flag: "wx" });
writeFileSync(
  join(root, "verification.json"),
  JSON.stringify({
    status: "passed",
    track: "smoke",
    nativeEpisodes: 16,
    upstreamContractFixtures: 4,
    externalFrameworksExecuted: false,
    modelCalls: 0,
  }),
  { flag: "wx" },
);
process.stdout.write(
  `${root}\nSmoke passed: native host, two result adapters, immutable reports, comparison and trends. No public benchmark score was produced.\n`,
);
