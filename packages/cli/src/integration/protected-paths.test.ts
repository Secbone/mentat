import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { afterEach, expect, it, vi } from "vitest";
import { iterateCommand } from "../commands/iterate";

const state = vi.hoisted(() => ({
  adapter: undefined as ReturnType<typeof createFakeAdapter> | undefined,
}));
vi.mock("../lib/registry", () => ({
  createDefaultRegistry: () => ({ has: () => true, get: () => state.adapter }),
}));
afterEach(() => vi.restoreAllMocks());

it("the CLI default protects the relocated evolution code and rolls back its modification", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const dir = mkdtempSync(join(tmpdir(), "mentat-protect-"));
  const repo = join(dir, "repo");
  const logs = join(dir, "logs");
  const protectedFile = "packages/evolution/src/loop.ts";
  mkdirSync(join(repo, "packages/evolution/src"), { recursive: true });
  const original = "export const value = 1;\n";
  writeFileSync(join(repo, protectedFile), original);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-b", "main");
  git("config", "user.email", "test@test");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-m", "initial");

  const adapter = createFakeAdapter();
  const create = adapter.createSession.bind(adapter);
  vi.spyOn(adapter, "createSession").mockImplementation(async (options, deps) => {
    const session = await create(options, deps);
    const send = session.send.bind(session);
    session.send = async (input, sendOptions) => {
      writeFileSync(join(repo, protectedFile), "export const value = 2;\n");
      await send(input, sendOptions);
    };
    return session;
  });
  state.adapter = adapter;
  expect(
    await iterateCommand([
      "--target",
      repo,
      "--task",
      "change a protected file",
      "--harness",
      "fake",
      "--check",
      "node -e 'process.exit(0)'",
      "--iterations",
      "1",
      "--log-dir",
      logs,
    ]),
  ).toBe(0);
  const run = readdirSync(logs)[0];
  const report = JSON.parse(readFileSync(join(logs, run ?? "", "run.json"), "utf8"));
  expect(report.records[0]).toMatchObject({ accepted: false, gatePassed: false });
  expect(report.records[0].reason).toContain(`protected path changed: ${protectedFile}`);
  expect(readFileSync(join(repo, protectedFile), "utf8")).toBe(original);
});
