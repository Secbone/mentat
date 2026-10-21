import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { decideWrite } from "@mentat/memory/write-rules";
import { withFileLock } from "@mentat/storage-file/lock";

function atomic(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp);
  }
}
function entriesAt(path) {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Array.isArray(value) ||
    new Set(value.map((entry) => entry?.id)).size !== value.length ||
    value.some(
      (e) =>
        !e ||
        typeof e.id !== "string" ||
        typeof e.text !== "string" ||
        !Number.isFinite(e.createdAt),
    )
  )
    throw new Error(`corrupt memory store: ${path}`);
  return value;
}
function recover(path) {
  const wal = `${path}.journal.json`;
  if (!existsSync(wal)) return;
  const transaction = JSON.parse(readFileSync(wal, "utf8"));
  if (!Array.isArray(transaction.entries) || typeof transaction.id !== "string")
    throw new Error("corrupt memory journal");
  atomic(path, `${JSON.stringify(transaction.entries, null, 2)}\n`);
  const audits = transaction.audits ?? (transaction.audit ? [transaction.audit] : []);
  if (audits.length) {
    const auditPath = transaction.auditPath ?? `${path}.audit.jsonl`;
    mkdirSync(dirname(auditPath), { recursive: true });
    const current = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";
    const records = current
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const additions = audits
      .map((record, index) => ({ ...record, transactionId: transaction.id, operationIndex: index }))
      .filter(
        (record) =>
          !records.some(
            (previous) =>
              previous.transactionId === record.transactionId &&
              (previous.operationIndex ?? 0) === record.operationIndex,
          ),
      );
    if (additions.length)
      atomic(
        auditPath,
        `${current}${current && !current.endsWith("\n") ? "\n" : ""}${additions.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
  }
  rmSync(wal);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function withMemoryLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(`${path}.lock`, () => {
    recover(path);
    return fn();
  });
}
export function memoryRevision(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
export function readMemory(path) {
  return withMemoryLock(path, () => entriesAt(path));
}
export function mutateMemory(path, mutate, audit, auditPath) {
  return withMemoryLock(path, () => {
    const entries = entriesAt(path);
    const result = mutate(entries);
    atomic(
      `${path}.journal.json`,
      JSON.stringify({ id: randomUUID(), entries, audits: audit?.(), auditPath }),
    );
    recover(path);
    return result;
  });
}
export function commitMemory(path, request, now = Date.now(), expectedRevision) {
  return withMemoryLock(path, () => {
    const entries = entriesAt(path);
    const revision = memoryRevision(entries);
    if (expectedRevision !== undefined && expectedRevision !== revision)
      throw new Error("MEMORY_CONFLICT: snapshot changed");
    const decision = decideWrite(entries, request, now);
    if ((decision.op === "add" || decision.op === "update") && decision.entry) {
      const index = entries.findIndex((e) => e.id === decision.entry.id);
      if (index < 0) entries.push(decision.entry);
      else entries[index] = decision.entry;
    }
    const id = randomUUID();
    atomic(
      `${path}.journal.json`,
      JSON.stringify({ id, entries, audit: { ts: now, request, ...decision } }),
    );
    try {
      recover(path);
    } catch (error) {
      throw new Error(`MEMORY_COMMIT_PENDING ${id}: committed to journal; recovery required`, {
        cause: error,
      });
    }
    return {
      op: decision.op,
      ...(decision.entry ? { entry: decision.entry } : {}),
      ...(decision.previous ? { previous: decision.previous } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
      transactionId: id,
    };
  });
}
