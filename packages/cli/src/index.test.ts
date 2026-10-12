import { describe, expect, it, vi } from "vitest";
import { run } from "./index";

function capture(): { output: () => string; restore: () => void } {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  return {
    output: () => write.mock.calls.map((call) => String(call[0])).join(""),
    restore: () => write.mockRestore(),
  };
}

describe("cli", () => {
  it("lists harnesses", async () => {
    const out = capture();
    const code = await run(["harness", "list"]);
    expect(code).toBe(0);
    expect(out.output()).toContain("fake");
    out.restore();
  });

  it("runs a prompt through the fake harness", async () => {
    const out = capture();
    const code = await run(["run", "hello", "world", "--harness", "fake"]);
    expect(code).toBe(0);
    expect(out.output()).toContain("fake: hello world");
    out.restore();
  });

  it("fails on an unknown harness", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await run(["run", "hi", "--harness", "nope"]);
    expect(code).toBe(1);
    write.mockRestore();
  });

  it("fails when no prompt is given", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await run(["run"]);
    expect(code).toBe(1);
    write.mockRestore();
  });
});
