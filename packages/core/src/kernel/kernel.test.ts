import { describe, expect, it } from "vitest";
import { createKernel } from "./kernel";
import { definePlugin } from "./plugin";

describe("Kernel", () => {
  it("applies plugins and registers services tree-wide", async () => {
    const kernel = createKernel();
    const disposable = await kernel.use(
      definePlugin({
        name: "greeter",
        apply: (ctx) => {
          ctx.provide("greeting", "hi");
        },
      }),
    );

    expect(kernel.root.get<string>("greeting")).toBe("hi");
    expect(kernel.list()).toContain("greeter");

    await disposable.dispose();
    expect(kernel.root.has("greeting")).toBe(false);
    await kernel.dispose();
  });

  it("rejects plugins whose injected services are missing", async () => {
    const kernel = createKernel();
    await expect(
      kernel.use(definePlugin({ name: "needs", inject: ["missing"], apply: () => {} })),
    ).rejects.toThrow(/missing service/);
    await kernel.dispose();
  });

  it("lets a plugin depend on a service provided by an earlier plugin", async () => {
    const kernel = createKernel();
    await kernel.use(
      definePlugin({
        name: "provider",
        apply: (ctx) => {
          ctx.provide("value", 42);
        },
      }),
    );
    const seen: number[] = [];
    await kernel.use(
      definePlugin({
        name: "consumer",
        inject: ["value"],
        apply: (ctx) => {
          seen.push(ctx.get<number>("value"));
        },
      }),
    );
    expect(seen).toEqual([42]);
    await kernel.dispose();
  });
});
