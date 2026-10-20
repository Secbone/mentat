import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { prepareOpenCodeMcp } from "./opencode-mcp";

it("keeps declared MCP tools direct and creates per-session catalog receipts", () => {
  const make = () =>
    prepareOpenCodeMcp([
      {
        name: "procedures",
        command: "node",
        args: ["fixture"],
        env: { SCOPE: "user-a" },
        catalogTools: ["skill_view"],
      },
    ]);
  const first = make(),
    second = make();
  try {
    expect(first.servers.procedures).toMatchObject({
      type: "local",
      codemode: false,
      command: ["node", "fixture"],
      environment: { SCOPE: "user-a" },
    });
    expect(first.catalog[0]?.tools).toEqual(["skill_view"]);
    expect(first.catalog[0]?.receiptPath).not.toBe(second.catalog[0]?.receiptPath);
    expect(first.catalog[0]?.token).not.toBe(second.catalog[0]?.token);
  } finally {
    first.dispose();
    second.dispose();
  }
  expect(existsSync(first.catalog[0]?.receiptPath ?? "")).toBe(false);
});
it("rejects namespace collisions instead of silently replacing a server", () => {
  expect(() =>
    prepareOpenCodeMcp([
      { name: "same", command: "a" },
      { name: "same", command: "b" },
    ]),
  ).toThrow("duplicate");
});
