import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAccess, InMemoryMemoryStore, MemoryService } from "@mentat/memory";
import { describe, expect, it } from "vitest";
import { JsonFileMemoryStore } from "./json-memory-store";
import { FileMemoryRepository } from "./repository";

const path = () => join(mkdtempSync(join(tmpdir(), "mentat-repository-")), "memory.json");
const user = (text: string) => ({ text, basis: "user" as const, speaker: "user" as const });
describe("file memory consistency", () => {
  it("preserves two pre-existing writers and reloads reads", () => {
    const file = path(),
      a = new JsonFileMemoryStore(file),
      b = new JsonFileMemoryStore(file);
    a.add({ id: "a", text: "first", createdAt: 1 });
    b.add({ id: "b", text: "second", createdAt: 2 });
    expect(a.list().map((e) => e.id)).toEqual(["a", "b"]);
  });
  it("detects optimistic conflicts without audit side effects", async () => {
    const file = path(),
      a = new FileMemoryRepository(file),
      b = new FileMemoryRepository(file);
    const snap = await a.snapshot();
    await b.commit(user("first"));
    await expect(a.commit(user("second"), { expectedRevision: snap.revision })).rejects.toThrow(
      "MEMORY_CONFLICT",
    );
    expect((await a.snapshot()).entries).toHaveLength(1);
    expect(readFileSync(`${file}.audit.jsonl`, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("recovers a committed journal exactly once", async () => {
    const file = path();
    writeFileSync(
      `${file}.journal.json`,
      JSON.stringify({
        id: "tx",
        entries: [{ id: "a", text: "recovered", createdAt: 1 }],
        audit: { op: "add", ts: 1, request: user("recovered") },
      }),
    );
    const repository = new FileMemoryRepository(file);
    expect((await repository.snapshot()).entries[0]?.text).toBe("recovered");
    await repository.snapshot();
    expect(existsSync(`${file}.journal.json`)).toBe(false);
    expect(readFileSync(`${file}.audit.jsonl`, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("refuses corrupt data and preserves the original file", async () => {
    const file = path();
    writeFileSync(file, "{broken");
    await expect(new FileMemoryRepository(file).commit(user("new"))).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });
  it("rolls back in-memory state when its audit rejects", () => {
    const store = new InMemoryMemoryStore(),
      service = new MemoryService(store, {
        record() {
          throw Error("audit unavailable");
        },
      });
    expect(() => service.write(user("new"))).toThrow("audit unavailable");
    expect(store.list()).toEqual([]);
  });
  it("binds scope and keeps model writes unconfirmed", async () => {
    const file = path(),
      repository = new FileMemoryRepository(file);
    await repository.commit({ ...user("other user's fact"), scope: "other" });
    const access = createMemoryAccess(repository, { scope: "mine" });
    await access.propose({ ...user("candidate"), scope: "other" });
    expect(await access.search({})).toMatchObject([
      { scope: "mine", status: "candidate", speaker: "assistant", basis: "inference" },
    ]);
    expect((await access.context("task")).text).toBe("");
  });
});

it("keeps a successful commit successful when an observer fails", async () => {
  const file = path(),
    repository = new FileMemoryRepository(file);
  const errors: unknown[] = [];
  const access = createMemoryAccess(repository, {
    observe() {
      throw Error("observer failed");
    },
    onObserverError: (error) => errors.push(error),
  });
  expect((await access.confirm(user("confirmed"))).op).toBe("add");
  expect(errors).toHaveLength(1);
  expect((await repository.snapshot()).entries).toHaveLength(1);
});

it("reports pending commits and repairs data plus audit after audit failure", async () => {
  const fs = await import("node:fs");
  const file = path();
  fs.mkdirSync(`${file}.audit.jsonl`);
  const repository = new FileMemoryRepository(file);
  await expect(repository.commit(user("pending"))).rejects.toThrow("MEMORY_COMMIT_PENDING");
  expect(fs.existsSync(`${file}.journal.json`)).toBe(true);
  fs.rmdirSync(`${file}.audit.jsonl`);
  expect((await repository.snapshot()).entries[0]?.text).toBe("pending");
  expect(JSON.parse(readFileSync(`${file}.audit.jsonl`, "utf8").trim()).transactionId).toBeTruthy();
});
it("serializes concurrent writes from independent Node processes", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const file = path();
  const script = fileURLToPath(new URL("./testing/writer.mjs", import.meta.url));
  const exec = promisify(execFile);
  await Promise.all(
    Array.from({ length: 4 }, (_, index) => exec(process.execPath, [script, file, String(index)])),
  );
  expect((await new FileMemoryRepository(file).snapshot()).entries).toHaveLength(20);
  expect(readFileSync(`${file}.audit.jsonl`, "utf8").trim().split("\n")).toHaveLength(20);
}, 10_000);
