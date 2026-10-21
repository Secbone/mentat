import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AcpRegistration, createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { ExperienceStore, inspectTrajectory, readTrajectory } from "@mentat/observability";

import { expect, it, vi } from "vitest";
import { runCommand } from "../commands/run";

const createAcpAdapter = (acp: AcpRegistration) => createDefaultRegistry("ask", { acp }).get("acp");

const fixture = fileURLToPath(
  new URL("../../../transport-acp/src/__fixtures__/turn-boundaries-acp.mjs", import.meta.url),
);
const response = (text: string) => ({
  updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }],
  result: { stopReason: "end_turn" },
});

it("preserves conflicting native and assistant termination evidence through persisted experience", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mentat-termination-"));
  const experienceDir = join(cwd, "experience");
  const text =
    "Maximum steps for this agent have been reached, so no further tool calls can be made.\nPartial result.";
  const host = createAssistantHost({
    cwd,
    experienceDir,
    memoryPath: join(cwd, "memory.json"),
    memoryTools: { memory: "disabled" },
    adapter: createAcpAdapter({
      binary: process.execPath,
      baseArgs: [fixture],
      env: { ACP_TEST_TURNS: JSON.stringify([response(text)]) },
    }),
  });
  try {
    const session = await host.open();
    const { result, record } = await host.turn(session, "task");
    expect(result).toMatchObject({
      reason: "done",
      termination: { source: "acp", rawReason: "end_turn", cause: "turn-ended" },
      completion: {
        response: "present",
        verification: "unverified",
        warnings: [{ code: "assistant-reported-step-limit", source: "assistant" }],
      },
    });
    expect(record).toMatchObject({
      termination: result.termination,
      completion: result.completion,
    });
    expect(
      new ExperienceStore(experienceDir).list().find((item) => item.id === record.id),
    ).toMatchObject({
      termination: result.termination,
      completion: result.completion,
    });
  } finally {
    await host.close();
  }
});

it("validates and corrects by default, preserving the original task in experience and audit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mentat-output-"));
  const host = createAssistantHost({
    cwd,
    memoryPath: join(cwd, "memory.json"),
    memoryTools: { memory: "disabled" },
    adapter: createAcpAdapter({
      binary: process.execPath,
      baseArgs: [fixture],
      env: {
        ACP_TEST_TURNS: JSON.stringify([
          response("<｜｜DSML｜｜ calls>unexecuted"),
          response("Lookup was not executed."),
        ]),
      },
    }),
  });
  try {
    const session = await host.open();
    const { result, record } = await host.turn(session, "original task");
    expect(result).toMatchObject({
      reason: "done",
      text: "Lookup was not executed.",
      correctiveTurns: 1,
    });
    expect(record.prompt).toBe("original task");
  } finally {
    await host.close();
  }
  if (!host.logDir) throw Error("missing log");
  expect(readTrajectory(host.logDir).filter((e) => e.type === "output.corrective")).toHaveLength(1);
  expect(inspectTrajectory(host.logDir)).toMatchObject({ gaps: 0, violations: [], turns: 1 });
});

it("supports explicit opt-out for protocol documentation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mentat-output-doc-"));
  const host = createAssistantHost({
    cwd,
    memoryPath: join(cwd, "memory.json"),
    memoryTools: { memory: "disabled" },
    requireFinalAnswer: false,
    adapter: createAcpAdapter({
      binary: process.execPath,
      baseArgs: [fixture],
      env: { ACP_TEST_TURNS: JSON.stringify([response("Example: <｜｜DSML｜｜ calls>")]) },
    }),
  });
  try {
    const { result } = await host.turn(await host.open(), "document syntax");
    expect(result.reason).toBe("done");
    expect(result.correctiveTurns).toBeUndefined();
  } finally {
    await host.close();
  }
});

it("CLI prints only the validated answer, hiding fragmented protocol from the first attempt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mentat-output-cli-"));
  const invalid = {
    updates: ["<｜｜DS", "ML｜｜ calls>", "unexecuted"].map((text) => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    })),
    result: { stopReason: "end_turn" },
  };
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("MENTAT_ACP_BIN", process.execPath);
  vi.stubEnv("MENTAT_ACP_ARGS", fixture);
  vi.stubEnv("ACP_TEST_TURNS", JSON.stringify([invalid, response("Lookup was not executed.")]));
  try {
    expect(await runCommand(["--harness", "acp", "--cwd", cwd, "lookup"])).toBe(0);
    expect(output.join("")).toContain("Lookup was not executed.");
    expect(output.join("")).not.toContain("DSML");
    expect(output.join("")).not.toContain("<｜｜DS");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    vi.unstubAllEnvs();
  }
});
