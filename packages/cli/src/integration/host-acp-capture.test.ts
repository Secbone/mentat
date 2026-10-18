import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { inspectTrajectory, projectExperience } from "@mentat/observability";
import { expect, it } from "vitest";

it("audits captured ACP fields and reconstructs updated experience from durable host logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentat-acp-capture-"));
  const stub = fileURLToPath(
    new URL("../../../transport-acp/src/__fixtures__/replay-acp-agent.mjs", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL("../../../transport-acp/src/__fixtures__/multiturn-tooling.json", import.meta.url),
  );
  const adapter = createDefaultRegistry("ask", {
    acp: { binary: process.execPath, baseArgs: [stub, fixture] },
  }).get("acp");
  const host = createAssistantHost({
    cwd: dir,
    adapter,
    memoryPath: join(dir, "memory.json"),
    protocolLog: true,
    permission: { request: () => "deny" },
  });
  let turnId = "";
  try {
    const session = await host.open();
    const { record, result } = await host.turn(session, "replay");
    turnId = result.turnId;
    expect(record.permissions).toHaveLength(42);
    expect(record.toolCalls?.filter((call) => call.kind === "call")).toHaveLength(17);
    expect(
      record.toolCalls?.filter(
        (call) => call.kind === "call" && call.input && JSON.stringify(call.input) !== "{}",
      ),
    ).toHaveLength(17);
  } finally {
    await host.close();
  }
  if (!host.logDir) throw Error("missing trace");
  expect(inspectTrajectory(host.logDir)).toMatchObject({
    violations: [],
    gaps: 0,
    capture: {
      status: "matched-captured-fields",
      protocolFrames: 124,
      tools: 17,
      permissionRequests: 21,
      issues: [],
    },
  });
  const projected = projectExperience(
    host.logDir,
    { prompt: "replay", cwd: dir, harness: "acp" },
    turnId,
  );
  expect(projected.permissions).toHaveLength(42);
  expect(
    projected.toolCalls?.filter((call) => call.kind === "result" && call.output.length > 0),
  ).toHaveLength(17);
});
