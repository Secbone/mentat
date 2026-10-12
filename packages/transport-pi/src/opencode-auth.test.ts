import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOpencodeModel, resolveOpencodeApiKey } from "./opencode-auth";

describe("resolveOpencodeApiKey", () => {
  it("prefers the environment variable", () => {
    expect(resolveOpencodeApiKey({ OPENCODE_API_KEY: "env-key" })).toBe("env-key");
  });

  it("reads opencode-go from the credential store", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-oc-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { key: "store-key" } }));
    expect(resolveOpencodeApiKey({ OPENCODE_DATA_HOME: dir, XDG_DATA_HOME: dir })).toBe(
      "store-key",
    );
  });

  it("returns undefined when nothing is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-oc-"));
    expect(resolveOpencodeApiKey({ OPENCODE_DATA_HOME: dir, XDG_DATA_HOME: dir })).toBeUndefined();
  });
});

describe("isOpencodeModel", () => {
  it("recognizes the opencode providers", () => {
    expect(isOpencodeModel("opencode-go/deepseek-v4.1-flash")).toBe(true);
    expect(isOpencodeModel("opencode/jev-1.13")).toBe(true);
    expect(isOpencodeModel("anthropic/claude")).toBe(false);
    expect(isOpencodeModel(undefined)).toBe(false);
  });
});
