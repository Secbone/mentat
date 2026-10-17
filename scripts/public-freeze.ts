/** Isolate source while retaining the pinned, existing dependency installation. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { materializeSourceArchive, sha256, verifySourceArchive } from "@mentat/benchmark-file";
import { checkoutIdentity } from "../packages/cli/src/lib/benchmark-subject";

const destination = process.argv[2];
if (!destination) throw new Error("usage: public-freeze.ts <new-directory>");
const out = resolve(destination),
  live = process.cwd();
mkdirSync(out);
const sourceArchive = join(out, "checkout-source.json"),
  source = join(out, "source");
const expected = checkoutIdentity(live, sourceArchive);
materializeSourceArchive(sourceArchive, source);
symlinkSync(join(live, "node_modules"), join(source, "node_modules"), "dir");
for (const name of readdirSync(join(source, "packages"))) {
  const dependencyPath = join(live, "packages", name, "node_modules");
  if (existsSync(dependencyPath))
    symlinkSync(dependencyPath, join(source, "packages", name, "node_modules"), "dir");
}
const identity = verifySourceArchive(source, sourceArchive);
if (identity.codeSha256 !== expected.codeSha256) throw new Error("snapshot differs from capture");
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      ...identity,
      source,
      sourceArchive,
      dependencyWorkspace: live,
      dependencyLockSha256: sha256(readFileSync(join(live, "pnpm-lock.yaml"))),
      limitations:
        "External dependency installation is shared and must retain the pinned lockfile; source files and TSX aliases must resolve inside source.",
    },
    null,
    2,
  ),
);
process.stdout.write(`${JSON.stringify({ ...identity, source, sourceArchive })}\n`);
