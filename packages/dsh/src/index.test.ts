import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply, type DshContext, type DshToolDefinition, type MentatService } from "./index";

function context() {
  const services = new Map<string, unknown>();
  const tools: DshToolDefinition[] = [];
  const ctx: DshContext = {
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, services, tools };
}

function tool(tools: DshToolDefinition[], name: string): DshToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("Mentat DSH plugin", () => {
  it("provides the control-plane service and its tools", async () => {
    const { ctx, services, tools } = context();
    apply(ctx, { dir: mkdtempSync(join(tmpdir(), "mentat-dsh-")) });
    expect(services.get("mentat")).toMatchObject({ runtime: expect.anything() });
    expect(tools.map((entry) => entry.name)).toEqual([
      "mentat_status",
      "mentat_receive",
      "mentat_dispatch",
      "mentat_run",
    ]);
    await expect(tool(tools, "mentat_status").execute({}, {})).resolves.toEqual({
      tickets: 0,
      threads: 0,
      decisions: 0,
      router: "",
    });
  });

  it("runs one request through the tool surface and records a receipt", async () => {
    const { ctx, services, tools } = context();
    apply(ctx, { dir: mkdtempSync(join(tmpdir(), "mentat-dsh-")) });
    const result = (await tool(tools, "mentat_run").execute(
      { text: "fix the failing test" },
      {},
    )) as {
      outcome: string;
      ticket: string;
      receipt: { outcome: string; report: { kind: string } };
    };
    expect(result.outcome).toBe("accept");
    expect(result.ticket).toBeTruthy();
    expect(result.receipt).toMatchObject({ outcome: "completed", report: { kind: "ready" } });
    const service = services.get("mentat") as MentatService;
    expect(service.repos.tickets.list()).toHaveLength(1);
  });
});
