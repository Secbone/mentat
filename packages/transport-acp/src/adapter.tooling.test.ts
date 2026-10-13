import { fileURLToPath } from "node:url";
import { runOnce } from "@mentat/core/testing";
import { describe, expect, it } from "vitest";
import { createAcpAdapter } from "./adapter";

const stub = fileURLToPath(new URL("./__fixtures__/stub-acp-agent.mjs", import.meta.url));

describe("acp adapter maps rich session updates", () => {
  it("maps thoughts, tool calls and text", async () => {
    const adapter = createAcpAdapter({
      binary: process.execPath,
      baseArgs: [stub],
      env: { STUB_ACP_TOOLING: "1" },
    });
    const session = await adapter.createSession({ cwd: process.cwd() });
    const { events } = await runOnce(session, { text: "hi" });

    expect(events.some((event) => event.type === "message.reasoning")).toBe(true);
    expect(events.find((event) => event.type === "tool.start")).toMatchObject({
      name: "read_file",
      id: "t1",
      input: { path: "x" },
    });
    expect(events.find((event) => event.type === "tool.result")).toMatchObject({
      id: "t1",
      output: "contents",
      isError: false,
    });
    const completed = events.find((event) => event.type === "message.completed");
    expect(completed?.type === "message.completed" ? completed.message.text : "").toBe("acp:hi");

    await session.dispose();
  });

  it("rejects a concurrent send while a run is in flight", async () => {
    const adapter = createAcpAdapter({ binary: process.execPath, baseArgs: [stub] });
    const session = await adapter.createSession({ cwd: process.cwd() });

    const first = session.send({ text: "one" });
    await expect(session.send({ text: "two" })).rejects.toThrow(/busy/);
    await first;

    await session.dispose();
  });
});
