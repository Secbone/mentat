import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectTrajectory } from "@mentat/observability";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const bin = resolve("packages/cli/src/bin.ts");
const cli = (args: string[], input?: string) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--import", "tsx", bin, ...args],
      { cwd: process.cwd(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
it("runs actual CLI task, chat, trace, feedback and evolution commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-cli-full-"));
  const logs = join(dir, "runs"),
    memory = join(dir, "memory.json"),
    experience = join(dir, "experience");
  await cli([
    "run",
    "--harness",
    "fake",
    "--cwd",
    dir,
    "--memory",
    memory,
    "--experience",
    experience,
    "--log-dir",
    logs,
    "--remember",
    "short answers",
    "--reflect",
    "hello",
  ]);
  const first = join(logs, readdirSync(logs)[0] ?? "missing");
  expect(inspectTrajectory(first)).toMatchObject({ status: "complete", gaps: 0, violations: [] });
  expect((await cli(["trace", first, "--context"])).stdout).toContain("prompt.assembled");
  expect((await cli(["trace", first, "--tree"])).stdout).toContain("turn.end");
  await cli(["trace", first, "--check"]);
  await cli(
    [
      "chat",
      "--harness",
      "fake",
      "--cwd",
      dir,
      "--memory",
      memory,
      "--experience",
      experience,
      "--log-dir",
      logs,
    ],
    "hello\n/remember reserve travel time\n/reflect\n/exit\n",
  );
  const summary = JSON.parse((await cli(["trace", first, "--summary"])).stdout) as {
    traceId: string;
  };
  expect(summary.traceId).toBeTruthy();
  const events = readFileSync(join(first, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { turnId?: string });
  const turnId = events.find((event) => event.turnId)?.turnId;
  if (!turnId) throw Error("no turn");
  await cli([
    "trace",
    "feedback",
    first,
    "--turn",
    turnId,
    "--score",
    "0",
    "--correction",
    "missed deadline",
  ]);
  expect((await cli(["trace", "compare", first, first])).stdout).toContain("missed deadline");
  const facts = join(dir, "facts.json"),
    queries = join(dir, "queries.json");
  writeFileSync(
    facts,
    JSON.stringify([{ id: "build", text: "build time three minutes", createdAt: 1 }]),
  );
  writeFileSync(queries, JSON.stringify([{ query: "build time", expectId: "build" }]));
  await cli([
    "evolve",
    "memory",
    "--facts",
    facts,
    "--queries",
    queries,
    "--memory",
    memory,
    "--store",
    join(dir, "versions"),
    "--log-dir",
    logs,
  ]);
  const repo = join(dir, "repo");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", ["-C", repo, "config", "user.name", "test"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, "file.txt"), "base");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-m", "base"]);
  await cli([
    "iterate",
    "--target",
    repo,
    "--harness",
    "fake",
    "--task",
    "test",
    "--check",
    "node -e 'console.log(123)'",
    "--log-dir",
    logs,
  ]);
  for (const name of readdirSync(logs)) expect(inspectTrajectory(join(logs, name)).gaps).toBe(0);
}, 30_000);
