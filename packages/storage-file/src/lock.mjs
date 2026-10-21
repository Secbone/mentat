import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

function ownerPid(value) {
  const record = JSON.parse(value);
  const pid = typeof record === "number" ? record : record.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("invalid file lock owner; manual recovery required");
  return pid;
}
function isDead(value) {
  try {
    process.kill(ownerPid(value), 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}
/** Owner bytes are published with an atomic hard link. Recovery is itself locked. */
export function acquireFileLock(path) {
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const temporary = `${path}.${randomUUID()}.owner`;
  writeFileSync(temporary, owner, { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try {
        previous = readFileSync(path, "utf8");
      } catch (readError) {
        if (readError.code === "ENOENT") throw new Error(`FILE_LOCKED: ${path}`);
        throw readError;
      }
      if (!isDead(previous)) throw new Error(`FILE_LOCKED: ${path}`);
      // Recursive barriers recover even a process that died while recovering a lock.
      const releaseRecovery = acquireFileLock(`${path}.recovery`);
      try {
        let current;
        try {
          current = readFileSync(path, "utf8");
        } catch (readError) {
          if (readError.code !== "ENOENT") throw readError;
        }
        if (current !== undefined) {
          if (!isDead(current)) throw new Error(`FILE_LOCKED: ${path}`);
          unlinkSync(path);
        }
        linkSync(temporary, path);
      } finally {
        releaseRecovery();
      }
    }
  } finally {
    unlinkSync(temporary);
  }
  return () => {
    if (readFileSync(path, "utf8") !== owner) throw new Error("file lock ownership changed");
    unlinkSync(path);
  };
}
export function withFileLock(path, fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let release;
  for (;;) {
    try {
      release = acquireFileLock(path);
      break;
    } catch (error) {
      if (!String(error.message).startsWith("FILE_LOCKED:") || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    release();
  }
}
