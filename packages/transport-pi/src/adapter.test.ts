import { fileURLToPath } from "node:url";
import type { PermissionDecision, PermissionRequest } from "@mentat/core";
import { describeHarnessContract, runOnce } from "@mentat/core/testing";
import { describe, expect, it } from "vitest";
import { createPiAdapter } from "./adapter";

const stub = fileURLToPath(new URL("./__fixtures__/fake-pi.mjs", import.meta.url));

function adapterFactory(env?: Record<string, string>) {
  return createPiAdapter({
    binary: process.execPath,
    baseArgs: [stub],
    permissionMode: "full",
    ...(env ? { env } : {}),
  });
}

describeHarnessContract("pi", () => adapterFactory());

describe("pi adapter permission bridge", () => {
  it("routes tool permission requests to the injected handler", async () => {
    const requests: Array<{ toolName: string }> = [];
    const adapter = createPiAdapter({
      binary: process.execPath,
      baseArgs: [stub],
      permissionMode: "ask",
      env: { FAKE_PI_PERM: "1" },
    });
    const session = await adapter.createSession(
      { cwd: process.cwd() },
      {
        onPermission: {
          request: (request: PermissionRequest): PermissionDecision => {
            requests.push({ toolName: request.toolName });
            return "deny";
          },
        },
      },
    );

    const { events } = await runOnce(session, { text: "dangerous" });
    expect(requests[0]).toEqual({ toolName: "bash" });

    const completed = events.find((event) => event.type === "message.completed");
    expect(completed?.type === "message.completed" ? completed.message.text : "").toBe("blocked");

    await session.dispose();
  });

  it("allows the tool when the handler approves", async () => {
    const adapter = createPiAdapter({
      binary: process.execPath,
      baseArgs: [stub],
      permissionMode: "ask",
      env: { FAKE_PI_PERM: "1" },
    });
    const session = await adapter.createSession(
      { cwd: process.cwd() },
      { onPermission: { request: (): PermissionDecision => "allow" } },
    );
    const { events } = await runOnce(session, { text: "ok" });
    const completed = events.find((event) => event.type === "message.completed");
    expect(completed?.type === "message.completed" ? completed.message.text : "").toBe("allowed");
    await session.dispose();
  });
});
