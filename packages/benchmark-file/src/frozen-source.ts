import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assert } from "@mentat/benchmark";
import { sha256 } from "./digest";

interface SourceArchive {
  revision: string;
  codeSha256: string;
  files: Array<{
    name: string;
    mode?: number;
    base64?: string;
    target?: string;
    deleted?: boolean;
  }>;
}
function archive(path: string): SourceArchive {
  const value = JSON.parse(readFileSync(path, "utf8")) as SourceArchive;
  assert(
    typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.codeSha256),
    "invalid source identity",
  );
  assert(Array.isArray(value.files) && value.files.length > 0, "source archive requires files");
  const names = new Set<string>();
  for (const file of value.files) {
    assert(
      typeof file.name === "string" &&
        file.name.length > 0 &&
        !isAbsolute(file.name) &&
        !file.name.split(/[\\/]/).some((s) => s === ".." || s === ".git") &&
        !names.has(file.name),
      "unsafe source path",
    );
    names.add(file.name);
  }
  return value;
}

/** Restore bytes from a captured checkout, never read newer live source contents. */
export function materializeSourceArchive(path: string, directory: string) {
  const data = archive(path);
  mkdirSync(directory);
  for (const file of data.files) {
    if (file.deleted) continue;
    const destination = join(directory, file.name);
    mkdirSync(dirname(destination), { recursive: true });
    if (typeof file.target === "string") symlinkSync(file.target, destination);
    else {
      assert(
        typeof file.base64 === "string" && typeof file.mode === "number",
        "unsupported source archive entry",
      );
      writeFileSync(destination, Buffer.from(file.base64, "base64"), {
        flag: "wx",
        mode: file.mode & 0o777,
      });
      chmodSync(destination, file.mode & 0o777);
    }
  }
  return verifySourceArchive(directory, path);
}

/** Check every archived source file before a new benchmark process runs. */
export function verifySourceArchive(directory: string, path: string) {
  const data = archive(path);
  const files = data.files.map((file) => {
    const source = join(directory, file.name);
    if (file.deleted) {
      try {
        lstatSync(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [file.name, "deleted"];
        throw error;
      }
      throw new Error(`deleted source reappeared: ${file.name}`);
    }
    const stat = lstatSync(source);
    assert(stat.mode === file.mode, `source mode changed: ${file.name}`);
    return [
      file.name,
      stat.mode,
      stat.isSymbolicLink()
        ? sha256(readlinkSync(source))
        : stat.isFile()
          ? sha256(readFileSync(source))
          : "non-file",
    ];
  });
  assert(sha256(JSON.stringify(files)) === data.codeSha256, "frozen source digest mismatch");
  return { revision: data.revision, codeSha256: data.codeSha256 };
}
