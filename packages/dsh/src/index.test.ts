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

describe("Mentat DSH plugin", () => {
  it("provides the control-plane service and a status tool", async () => {
    const { ctx, services, tools } = context();
    apply(ctx);
    expect(services.get("mentat")).toMatchObject({ engine: expect.anything() });
    expect(tools.map((tool) => tool.name)).toEqual(["mentat_status"]);
    const tool = tools[0];
    if (!tool) throw new Error("missing status tool");
    await expect(tool.execute({}, {})).resolves.toEqual({
      tickets: 0,
      threads: 0,
      decisions: 0,
    });
  });

  it("exposes the engine to other plugins through the service", () => {
    const { ctx, services } = context();
    apply(ctx);
    const service = services.get("mentat") as MentatService;
    expect(
      service.engine.receive({
        id: "t1",
        source: "local",
        thread: "th1",
        actor: "alice",
        bot: false,
        addressed: "mention",
        text: "hello",
        at: "2026-11-05T00:00:00.000Z",
      }),
    ).toBe("stored");
    expect(service.repos.triggers.list()).toHaveLength(1);
  });
});
