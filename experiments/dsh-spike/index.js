export const name = "mentat-spike";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.provide("mentatSpike", { ping: () => "pong" });
  ctx.tools.register({
    name: "mentat_ping",
    description: "Return pong from the Mentat DSH spike plugin.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: { pong: { type: "boolean" } },
        required: ["pong"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute() {
      return { pong: true };
    },
  });
  console.error("[mentat-spike] loaded");
  setTimeout(() => {
    try {
      const names = ctx.tools.schemas().map((tool) => tool.name);
      console.error(
        "[mentat-spike] tools",
        names.filter((name) => name === "mentat_ping"),
      );
      console.error("[mentat-spike] service", ctx.get("mentatSpike")?.ping?.());
    } catch (error) {
      console.error("[mentat-spike] probe failed", error);
    }
  }, 50);
}
