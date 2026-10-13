import { fileURLToPath } from "node:url";
import { describeHarnessContract, runOnce } from "@mentat/core/testing";
import { describe, expect, it } from "vitest";
import { createAcpAdapter } from "./adapter";

const stub = fileURLToPath(new URL("./__fixtures__/stub-acp-agent.mjs", import.meta.url));

const make = () => createAcpAdapter({ binary: process.execPath, baseArgs: [stub] });

// The frozen, agent-un-editable acceptance contract for the ACP transport.
describeHarnessContract("acp", make);

describe("acp adapter speaks the stub agent over the wire", () => {
  it("echoes the prompt through ACP session/update chunks", async () => {
    const adapter = make();
    const session = await adapter.createSession({ cwd: process.cwd() });
    const { events, end } = await runOnce(session, { text: "hello" });
    const completed = events.find((event) => event.type === "message.completed");
    const text = completed?.type === "message.completed" ? completed.message.text : "";
    expect(text).toBe("acp:hello");
    expect(end).toMatchObject({ type: "run.settled", reason: "done" });
    await session.dispose();
  });
});
