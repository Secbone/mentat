import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareFilePolicy, prepareOutputContract } from "./task-contract";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mentat-contract-")));
  const work = join(root, "work"),
    control = join(root, "control");
  mkdirSync(work);
  mkdirSync(control);
  mkdirSync(join(work, "nested"));
  writeFileSync(join(work, "input.txt"), "source");
  return { root, work, control };
}
const policy = { kind: "file-allowlist", readFiles: ["input.txt"], writeFiles: ["result.json"] };
const schema = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: { value: { type: "string", minLength: 1 } },
};
describe("worker file policy audit", () => {
  it("allows declared output, but rejects changed nested inputs and unexpected directories", () => {
    const { work } = fixture();
    writeFileSync(join(work, "nested/private.txt"), "old");
    const guard = prepareFilePolicy(work, policy);
    writeFileSync(join(work, "result.json"), "{}");
    expect(guard.audit().issues).toEqual([]);
    writeFileSync(join(work, "nested/private.txt"), "changed");
    mkdirSync(join(work, "unexpected"));
    expect(guard.audit().issues).toEqual(
      expect.arrayContaining([
        "input or existing entry changed: nested/private.txt",
        "unexpected entry: unexpected",
      ]),
    );
  });
  it.each(["../escape.json", "*.json", "result?.json", "bad\\name", "input.txt"])(
    "rejects unsafe or overlapping output %s",
    (output) => {
      const { work } = fixture();
      expect(() => prepareFilePolicy(work, { ...policy, writeFiles: [output] })).toThrow();
    },
  );
  it("rejects pre-existing outputs and linked entries, including links introduced after execution", () => {
    const { work, control } = fixture();
    const guard = prepareFilePolicy(work, policy);
    symlinkSync(join(work, "input.txt"), join(work, "result.json"));
    expect(() => guard.audit()).toThrow("linked");
    const second = fixture();
    writeFileSync(join(second.work, "result.json"), "stale");
    expect(() => prepareFilePolicy(second.work, policy)).toThrow("must not exist");
    const third = fixture();
    linkSync(join(third.work, "input.txt"), join(control, "hardlink.txt"));
    expect(() => prepareFilePolicy(third.work, policy)).toThrow("linked");
  });
});

describe("output contracts", () => {
  it("refuses pre-existing results and control directories inside the task", () => {
    const { work, control } = fixture();
    expect(() => prepareOutputContract(work, { outputFile: "result.json", schema }, work)).toThrow(
      "control",
    );
    writeFileSync(join(work, "result.json"), '{"value":"old"}');
    expect(() =>
      prepareOutputContract(work, { outputFile: "result.json", schema }, control),
    ).toThrow("must not exist");
  });
  it("bounds a hung host validator without accepting its output", async () => {
    const { work, control } = fixture();
    const prepared = prepareOutputContract(
      work,
      {
        outputFile: "result.json",
        schema,
        validator: {
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          timeoutMs: 30,
        },
      },
      control,
    );
    writeFileSync(join(work, "result.json"), '{"value":"source"}');
    expect(await prepared.evaluate(new AbortController().signal)).toMatchObject({
      status: "error",
      issues: ["host validator command failed"],
    });
  });
  it("validates without coercion or defaults, retaining the exact output bytes", async () => {
    const { work, control } = fixture();
    const prepared = prepareOutputContract(work, { outputFile: "result.json", schema }, control);
    const path = join(work, "result.json");
    for (const value of [null, "", 42]) {
      writeFileSync(path, JSON.stringify({ value }));
      expect((await prepared.evaluate(new AbortController().signal)).status).toBe("rejected");
    }
    const bytes = '{ "value": "source" }\n';
    writeFileSync(path, bytes);
    expect(await prepared.evaluate(new AbortController().signal)).toMatchObject({
      status: "accepted",
      evidence: { coverage: "json-schema-only" },
    });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it("rejects missing, invalid JSON and symlink outputs without accepting a stale value", async () => {
    const { work, control } = fixture();
    const prepared = prepareOutputContract(work, { outputFile: "result.json", schema }, control);
    await expect(prepared.evaluate(new AbortController().signal)).rejects.toThrow();
    writeFileSync(join(work, "result.json"), "{bad");
    await expect(prepared.evaluate(new AbortController().signal)).rejects.toThrow();
    const other = fixture();
    const otherContract = prepareOutputContract(
      other.work,
      { outputFile: "result.json", schema },
      other.control,
    );
    symlinkSync(join(other.work, "input.txt"), join(other.work, "result.json"));
    await expect(otherContract.evaluate(new AbortController().signal)).rejects.toThrow(
      "non-linked",
    );
  });
  it("does not treat a validator's zero exit code or malformed verdict as acceptance", async () => {
    for (const script of [
      "console.log('ok')",
      "console.log(JSON.stringify({accepted:true,issues:['failure']}))",
    ]) {
      const { work, control } = fixture();
      const prepared = prepareOutputContract(
        work,
        {
          outputFile: "result.json",
          schema,
          validator: { command: process.execPath, args: ["-e", script] },
        },
        control,
      );
      writeFileSync(join(work, "result.json"), '{"value":"source"}');
      expect((await prepared.evaluate(new AbortController().signal)).status).toBe("error");
    }
  });
  it("runs a domain validator on a snapshot and preserves its rejection evidence", async () => {
    const { work, control } = fixture();
    const script =
      "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));console.log(JSON.stringify({accepted:false,issues:['domain rejected '+c.value.value]}))";
    const prepared = prepareOutputContract(
      work,
      {
        outputFile: "result.json",
        schema,
        validator: { command: process.execPath, args: ["-e", script] },
      },
      control,
    );
    writeFileSync(join(work, "result.json"), '{"value":"source"}');
    expect(await prepared.evaluate(new AbortController().signal)).toMatchObject({
      status: "rejected",
      issues: ["domain rejected source"],
      evidence: { exitCode: 0, coverage: "json-schema-and-host-validator" },
    });
  });
  it("rejects async, unresolved remote, and malformed schemas before model dispatch", () => {
    const { work, control } = fixture();
    for (const invalid of [
      { $async: true },
      { $ref: "https://invalid.example/schema.json" },
      { type: "invalid" },
    ])
      expect(() =>
        prepareOutputContract(work, { outputFile: "result.json", schema: invalid }, control),
      ).toThrow();
  });
});
