import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireFileLock, atomicJson, withFileLock } from "./index";

it("refuses a live writer, preserves its owner, and releases after failure", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-lock-")), "store.lock");
  const release = acquireFileLock(path),
    owner = readFileSync(path, "utf8");
  expect(() => withFileLock(path, () => {}, 0)).toThrow("FILE_LOCKED");
  expect(readFileSync(path, "utf8")).toBe(owner);
  release();
  expect(() =>
    withFileLock(path, () => {
      throw new Error("failed mutation");
    }),
  ).toThrow("failed mutation");
  expect(existsSync(path)).toBe(false);
});

it("recovers both a dead owner and an interrupted recovery without stealing live locks", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-dead-lock-")), "store.lock");
  const pid = Number(
    execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }),
  );
  const dead = JSON.stringify({ pid, nonce: "dead" });
  writeFileSync(path, dead);
  writeFileSync(`${path}.recovery`, dead);
  expect(withFileLock(path, () => "recovered")).toBe("recovered");
  expect(existsSync(path)).toBe(false);
  expect(existsSync(`${path}.recovery`)).toBe(false);
});

it("atomically replaces a durable JSON pointer", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentat-pointer-")), "current.json");
  atomicJson(path, { active: "a" });
  atomicJson(path, { active: "b" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ active: "b" });
});
