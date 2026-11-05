export const name = "agent-probe";
export const inject = ["agents"];
export function apply(ctx) {
  setTimeout(async () => {
    try {
      const handle = await ctx.agents.create({
        sessionId: "probe-session-1",
        meta: { cwd: "/tmp" },
      });
      console.error("[agent-probe] created", handle.agent.id);
      await handle.dispose();
      console.error("[agent-probe] disposed");
    } catch (error) {
      console.error("[agent-probe] failed", error.message);
    }
  }, 500);
}
