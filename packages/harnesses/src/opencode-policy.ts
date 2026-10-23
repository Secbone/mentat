import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExecutionPolicy } from "@mentat/core";

/** Deliberately exact paths: OpenCode interprets * and ? as permission patterns. */
export function opencodeFilePolicy(cwd: string, policy: ExecutionPolicy) {
  const root = resolve(cwd);
  if (realpathSync(root) !== root || /[*?\\]/.test(root))
    throw new Error("execution policy requires a canonical workspace without pattern characters");
  if (
    policy.kind !== "file-allowlist" ||
    !Array.isArray(policy.readFiles) ||
    !Array.isArray(policy.writeFiles)
  )
    throw new Error("invalid execution policy");
  const normalize = (name: string, writable: boolean) => {
    if (
      typeof name !== "string" ||
      !name ||
      /[*?\\]/.test(name) ||
      [...name].some((c) => c.charCodeAt(0) < 32)
    )
      throw new Error("execution policy requires literal file paths");
    const absolute = resolve(root, name),
      local = relative(root, absolute);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error("execution policy path escapes workspace");
    const parent = dirname(absolute);
    if (realpathSync(parent) !== parent)
      throw new Error("execution policy forbids symlink parents");
    let entry: ReturnType<typeof lstatSync> | undefined;
    try {
      entry = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1))
      throw new Error("execution policy requires regular non-linked files");
    if (!writable && !entry) throw new Error("execution policy input does not exist");
    return { absolute, local: local.split(sep).join("/") };
  };
  const read = policy.readFiles.map((p) => normalize(p, false));
  const write = policy.writeFiles.map((p) => normalize(p, true));
  if (write.some((p) => read.some((q) => p.absolute === q.absolute)))
    throw new Error("immutable inputs cannot also be writable");
  const rules = [{ action: "*", resource: "*", effect: "deny" }];
  for (const [action, paths] of [
    ["read", read],
    ["edit", write],
  ] as const)
    for (const path of paths)
      for (const resource of [path.local, path.absolute])
        rules.push({ action, resource, effect: "allow" });
  return rules;
}
