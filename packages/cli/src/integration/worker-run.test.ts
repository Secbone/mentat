import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter, type HarnessAdapter } from "@mentat/core";
import { ExperienceStore, projectExperience, readTrajectory } from "@mentat/observability";
import { afterEach, expect, it, vi } from "vitest";
import { runCommand } from "../commands/run";

const state = vi.hoisted(() => ({ adapter: undefined as HarnessAdapter | undefined }));
vi.mock("../lib/registry", () => ({
  createDefaultRegistry: () => ({ has: () => true, get: () => state.adapter }),
}));
afterEach(() => vi.restoreAllMocks());

function fixture(value: unknown, mutate = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mentat-worker-cli-"))),
    work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "input.txt"), "source");
  const policy = join(root, "policy.json"),
    contract = join(root, "output.json");
  writeFileSync(
    policy,
    JSON.stringify({
      kind: "file-allowlist",
      readFiles: ["input.txt"],
      writeFiles: ["result.json"],
    }),
  );
  writeFileSync(
    contract,
    JSON.stringify({
      outputFile: "result.json",
      schema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
    }),
  );
  const fake = createFakeAdapter({
    script: () => {
      writeFileSync(join(work, "result.json"), JSON.stringify({ value }));
      if (mutate) writeFileSync(join(work, "input.txt"), "mutated");
      return ["finished"];
    },
  });
  // Test-only producer. Native enforcement is verified separately through the OpenCode adapter.
  state.adapter = {
    ...fake,
    capabilities: () => ({ ...fake.capabilities(), executionPolicy: "file-allowlist" }),
    createSession: ({ executionPolicy: _, ...options }, deps) => fake.createSession(options, deps),
  };
  return { root, work, policy, contract };
}

it.each([
  ["source", false, 0, "accepted"],
  [null, false, 2, "rejected"],
  ["source", true, 2, "rejected"],
] as const)(
  "keeps execution done separate from acceptance (%s, mutate=%s)",
  async (value, mutate, exit, status) => {
    const f = fixture(value, mutate);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(
      await runCommand([
        "task",
        "--harness",
        "fixture",
        "--cwd",
        f.work,
        "--execution-policy",
        f.policy,
        "--output-contract",
        f.contract,
      ]),
    ).toBe(exit);
    const text = stderr.mock.calls.map((c) => String(c[0])).join("");
    const control = text.match(/^control: (.+)$/m)?.[1],
      trace = text.match(/^trace: (.+)$/m)?.[1];
    expect(control).toBeDefined();
    expect(trace).toBeDefined();
    if (!control || !trace) throw Error("missing paths");
    const record = new ExperienceStore(join(control, "experience")).list()[0];
    expect(record).toMatchObject({ outcome: "done", acceptance: { status } });
    const rebuilt = projectExperience(
      trace,
      { prompt: "task", cwd: f.work, harness: "fixture" },
      record?.turnId ?? "",
    );
    expect(rebuilt.acceptance).toEqual(record?.acceptance);
    expect(readTrajectory(trace).some((e) => e.type === "task.acceptance")).toBe(true);
    expect(readFileSync(join(control, "contract.json"), "utf8")).toContain("policyFingerprint");
  },
);

it("rejects unsupported engines before creating a model session", async () => {
  const f = fixture("source");
  const fake = createFakeAdapter();
  const create = vi.spyOn(fake, "createSession");
  state.adapter = fake;
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await runCommand(["task", "--cwd", f.work, "--execution-policy", f.policy])).toBe(1);
  expect(create).not.toHaveBeenCalled();
});
