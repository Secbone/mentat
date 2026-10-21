import { describe, expect, it } from "vitest";
import { Context } from "./context";

describe("Context", () => {
  it("shares services across the context tree", () => {
    const root = new Context(undefined, "root");
    const child = root.fork("child");
    child.provide("a", 1);
    expect(root.get<number>("a")).toBe(1);
    expect(child.has("a")).toBe(true);
  });

  it("throws for unknown services", () => {
    expect(() => new Context().get("nope")).toThrow(/Service not found/);
  });

  it("runs effects in reverse order on dispose", async () => {
    const ctx = new Context();
    const order: number[] = [];
    ctx.effect(() => {
      order.push(1);
    });
    ctx.effect(() => {
      order.push(2);
    });
    await ctx.dispose();
    expect(order).toEqual([2, 1]);
  });

  it("restores a service when a provide disposable is disposed", () => {
    const ctx = new Context();
    const disposable = ctx.provide("a", 1);
    expect(ctx.has("a")).toBe(true);
    disposable.dispose();
    expect(ctx.has("a")).toBe(false);
  });

  it("bubbles events to parent scopes", () => {
    const root = new Context();
    const child = root.fork();
    const seen: string[] = [];
    root.on("ping", (value) => {
      seen.push(`root:${String(value)}`);
    });
    child.emit("ping", "x");
    expect(seen).toEqual(["root:x"]);
  });
});

it("isolates task service overrides from root and siblings", () => {
  const root = new Context();
  root.provide("identity", "root");
  const a = root.isolate(),
    b = root.isolate();
  a.provide("identity", "a");
  expect(b.get("identity")).toBe("root");
  expect(root.get("identity")).toBe("root");
});
it("does not run a manually disposed effect again", async () => {
  const ctx = new Context();
  let count = 0;
  const effect = ctx.effect(() => {
    count++;
  });
  await effect.dispose();
  await ctx.dispose();
  expect(count).toBe(1);
});
it("does not resurrect an unregistered service when sibling overrides dispose out of order", async () => {
  const root = new Context();
  const a = root.fork("a"),
    b = root.fork("b");
  a.provide("service", "a");
  b.provide("service", "b");
  await a.dispose();
  expect(root.get("service")).toBe("b");
  await b.dispose();
  expect(root.has("service")).toBe(false);
});
