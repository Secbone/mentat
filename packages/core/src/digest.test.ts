import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, digestOf, sha256Hex } from "./digest";

describe("sha256Hex", () => {
  it("matches the standard vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("canonicalJson", () => {
  it("sorts object keys but preserves array order", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });

  it("is stable across key insertion order", () => {
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf([1, 2])).not.toBe(digestOf([2, 1]));
  });

  it("rejects values that cannot be represented as JSON", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow("non-finite");
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow("non-finite");
  });

  it("produces a sha256 content address", () => {
    expect(digestOf({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("matches node:crypto across padding and unicode boundaries", () => {
    const inputs = [
      "",
      "a",
      "abc",
      "中文内容",
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(63),
      "x".repeat(64),
      "x".repeat(1000),
      canonicalJson({ z: 1, a: ["中文", true, null], nested: { b: 2 } }),
    ];
    for (const input of inputs) {
      expect(sha256Hex(input), input.slice(0, 20)).toBe(
        createHash("sha256").update(input).digest("hex"),
      );
    }
  });
});
