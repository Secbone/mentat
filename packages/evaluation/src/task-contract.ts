import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecutionPolicy, JsonValue, TaskAcceptance } from "@mentat/core";
import { Ajv2020 } from "ajv/dist/2020.js";
import { runCommand } from "./command-gate";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function isWithin(root: string, path: string): boolean {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`);
}

/** Bounded, recursive post-state audit. This does not prove an input was never temporarily changed. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  let count = 0,
    bytes = 0;
  const visit = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      if (++count > 10000) throw new Error("worker directory exceeds 10000 entries");
      const full = join(path, name),
        info = lstatSync(full),
        key = relative(root, full);
      if (
        info.isSymbolicLink() ||
        (!info.isFile() && !info.isDirectory()) ||
        (info.isFile() && info.nlink !== 1)
      )
        throw new Error(`worker forbids linked or special files: ${key}`);
      if (info.isDirectory()) {
        entries[key] = "directory";
        visit(full);
      } else {
        bytes += info.size;
        if (bytes > 64 * 1024 * 1024) throw new Error("worker directory exceeds 64 MiB");
        entries[key] = `file:${info.mode}:${hash(readFileSync(full))}`;
      }
    }
  };
  visit(root);
  return entries;
}

export function prepareFilePolicy(cwd: string, raw: unknown) {
  const root = realpathSync(cwd);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid execution policy");
  const data = raw as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !["kind", "readFiles", "writeFiles"].includes(key)) ||
    data.kind !== "file-allowlist" ||
    !Array.isArray(data.readFiles) ||
    !Array.isArray(data.writeFiles) ||
    !data.writeFiles.length
  )
    throw new Error("expected file-allowlist with readFiles and nonempty writeFiles");
  const names = (values: unknown[]) =>
    values.map((value) => {
      if (
        typeof value !== "string" ||
        !value ||
        /[*?\\]/.test(value) ||
        [...value].some((c) => c.charCodeAt(0) < 32)
      )
        throw new Error("policy paths must be literal files");
      const path = resolve(root, value);
      if (path === root || !isWithin(root, path)) throw new Error("policy path escapes workspace");
      if (realpathSync(dirname(path)) !== dirname(path))
        throw new Error("policy forbids symlink parents");
      return relative(root, path);
    });
  const readFiles = names(data.readFiles),
    writeFiles = names(data.writeFiles);
  if (
    /[*?\\]/.test(root) ||
    new Set([...readFiles, ...writeFiles]).size !== readFiles.length + writeFiles.length
  )
    throw new Error("policy has duplicate/overlapping paths or pattern characters");
  const before = snapshot(root);
  for (const name of readFiles)
    if (!before[name]?.startsWith("file:")) throw new Error(`missing input: ${name}`);
  for (const name of writeFiles)
    if (Object.hasOwn(before, name))
      throw new Error(`output must not exist before execution: ${name}`);
  const policy: ExecutionPolicy = { kind: "file-allowlist", readFiles, writeFiles };
  return {
    root,
    policy,
    before,
    fingerprint: hash(JSON.stringify({ root, policy, before })),
    audit() {
      if (realpathSync(root) !== root) throw new Error("worker root changed");
      const after = snapshot(root),
        issues: string[] = [];
      for (const [name, value] of Object.entries(before))
        if (after[name] !== value) issues.push(`input or existing entry changed: ${name}`);
      for (const name of Object.keys(after))
        if (!Object.hasOwn(before, name) && !writeFiles.includes(name))
          issues.push(`unexpected entry: ${name}`);
      return { before, after, issues };
    },
  };
}

export interface OutputContract {
  outputFile: string;
  schema: Record<string, unknown> | boolean;
  validator?: { command: string; args?: string[]; timeoutMs?: number };
}

/** Compile a trusted, local draft-2020-12 schema before starting any model request. */
export function prepareOutputContract(root: string, raw: unknown, control: string) {
  root = realpathSync(root);
  control = realpathSync(control);
  if (isWithin(root, control)) throw new Error("validator control must be outside task directory");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid output contract");
  const data = raw as OutputContract;
  if (
    Object.keys(raw).some((key) => !["outputFile", "schema", "validator"].includes(key)) ||
    typeof data.outputFile !== "string" ||
    !data.outputFile ||
    /[*?\\]/.test(data.outputFile) ||
    [...data.outputFile].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error("invalid output contract fields");
  const output = resolve(root, data.outputFile);
  if (
    !isWithin(root, output) ||
    output === root ||
    realpathSync(dirname(output)) !== dirname(output)
  )
    throw new Error("output path escapes workspace or uses symlink parents");
  try {
    lstatSync(output);
    throw new Error("output must not exist before execution");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !(
      typeof data.schema === "boolean" ||
      (data.schema && typeof data.schema === "object" && !Array.isArray(data.schema))
    ) ||
    (typeof data.schema === "object" && data.schema.$async)
  )
    throw new Error("expected synchronous JSON Schema");
  if (
    Object.hasOwn(data, "validator") &&
    (!data.validator || typeof data.validator !== "object" || Array.isArray(data.validator))
  )
    throw new Error("invalid host validator command");
  if (
    data.validator &&
    (typeof data.validator.command !== "string" ||
      !data.validator.command ||
      (data.validator.args !== undefined &&
        (!Array.isArray(data.validator.args) ||
          data.validator.args.some((arg) => typeof arg !== "string"))) ||
      !Number.isSafeInteger(data.validator.timeoutMs ?? 20000) ||
      (data.validator.timeoutMs ?? 20000) <= 0 ||
      (data.validator.timeoutMs ?? 20000) > 120000)
  )
    throw new Error("invalid host validator command");
  const validate = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  }).compile(data.schema);
  const fingerprint = hash(JSON.stringify(data));
  return {
    output,
    fingerprint,
    async evaluate(signal: AbortSignal): Promise<Omit<TaskAcceptance, "evaluator">> {
      const info = lstatSync(output);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 8 * 1024 * 1024 ||
        realpathSync(output) !== output
      )
        throw new Error("result must be a regular non-linked file of at most 8 MiB");
      const bytes = readFileSync(output),
        value = JSON.parse(bytes.toString("utf8"));
      const evidence = { outputSha256: hash(bytes), contractSha256: fingerprint };
      if (!validate(value))
        return {
          status: "rejected",
          issues: (validate.errors ?? [])
            .map((error) => `${error.instancePath || "/"}: ${error.message}`)
            .slice(0, 100),
          evidence,
        };
      if (!data.validator)
        return {
          status: "accepted",
          issues: [],
          evidence: { ...evidence, coverage: "json-schema-only" },
        };
      // The validator receives a host-owned snapshot, never a model-editable script/path.
      const context = join(control, `validation-${crypto.randomUUID()}.json`);
      writeFileSync(
        context,
        JSON.stringify({
          schemaVersion: 1,
          outputFile: output,
          outputSha256: evidence.outputSha256,
          value,
        }),
        { flag: "wx", mode: 0o400 },
      );
      const result = await runCommand({
        cwd: control,
        command: data.validator.command,
        args: [...(data.validator.args ?? []), context],
        timeoutMs: data.validator.timeoutMs ?? 20000,
        signal,
      });
      const commandEvidence: JsonValue = {
        ...evidence,
        coverage: "json-schema-and-host-validator",
        command: data.validator.command,
        args: data.validator.args ?? [],
        context,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      if (!result.ok)
        return {
          status: "error",
          issues: ["host validator command failed"],
          evidence: commandEvidence,
        };
      let verdict: { accepted?: unknown; issues?: unknown };
      try {
        verdict = JSON.parse(result.stdout);
      } catch {
        return {
          status: "error",
          issues: ["host validator must return JSON, not just exit 0"],
          evidence: commandEvidence,
        };
      }
      if (
        !verdict ||
        typeof verdict.accepted !== "boolean" ||
        !Array.isArray(verdict.issues) ||
        verdict.issues.some((issue) => typeof issue !== "string") ||
        (verdict.accepted && verdict.issues.length)
      )
        return {
          status: "error",
          issues: ["invalid host validator verdict"],
          evidence: commandEvidence,
        };
      const finalInfo = lstatSync(output);
      if (
        !finalInfo.isFile() ||
        finalInfo.isSymbolicLink() ||
        finalInfo.nlink !== 1 ||
        realpathSync(output) !== output ||
        finalInfo.ino !== info.ino ||
        finalInfo.dev !== info.dev ||
        finalInfo.size > 8 * 1024 * 1024 ||
        hash(readFileSync(output)) !== evidence.outputSha256
      )
        return {
          status: "rejected",
          issues: ["result changed during validation"],
          evidence: commandEvidence,
        };
      return {
        status: verdict.accepted ? "accepted" : "rejected",
        issues: verdict.issues as string[],
        evidence: commandEvidence,
      };
    },
  };
}
