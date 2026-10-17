import { fileURLToPath } from "node:url";
import { runOnce } from "@mentat/core/testing";
import { expect, it } from "vitest";
import { createAcpAdapter } from "./adapter";

const fixture = fileURLToPath(new URL("./__fixtures__/model-selection-acp.mjs", import.meta.url));
it("selects and verifies the requested model before submitting any task", async () => {
  const records: Array<{ code: string; message: string }> = [];
  const methods: string[] = [];
  const adapter = createAcpAdapter({ binary: process.execPath, baseArgs: [fixture] });
  const session = await adapter.createSession(
    { cwd: process.cwd(), model: "provider/target" },
    {
      onDiagnostic: (r) => records.push(r),
      onProtocol: (r) => {
        const d = r.data as { method?: string };
        if (r.direction === "out" && d.method) methods.push(d.method);
      },
    },
  );
  try {
    const { events } = await runOnce(session, { text: "task" });
    expect(methods.indexOf("session/set_config_option")).toBeLessThan(
      methods.indexOf("session/prompt"),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.delta", text: "provider/target" }),
    );
    expect(
      JSON.parse(records.find((r) => r.code === "ACP_MODEL_CONFIRMED")?.message ?? "{}"),
    ).toEqual({ requested: "provider/target", effective: "provider/target" });
  } finally {
    await session.dispose();
  }
});

it("rejects an ignored model selection without submitting a task", async () => {
  const methods: string[] = [];
  const adapter = createAcpAdapter({
    binary: process.execPath,
    baseArgs: [fixture],
    env: { IGNORE_MODEL_SELECTION: "1" },
  });
  await expect(
    adapter.createSession(
      { cwd: process.cwd(), model: "provider/target" },
      {
        onProtocol: (r) => {
          const d = r.data as { method?: string };
          if (r.direction === "out" && d.method) methods.push(d.method);
        },
      },
    ),
  ).rejects.toThrow("selection unverified");
  expect(methods).not.toContain("session/prompt");
});
