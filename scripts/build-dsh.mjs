#!/usr/bin/env node
// Bundle the DSH plugin entries and copy the Pi bridge next to them, so a
// file-URL profile has the same runtime layout as an installed package.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "dist", "dsh"));
mkdirSync(out, { recursive: true });
mkdirSync(join(out, "bridge"), { recursive: true });
mkdirSync(join(out, "dsh-client"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  sourcemap: false,
};

await build({
  ...common,
  entryPoints: [join(root, "packages/dsh/src/index.ts")],
  outfile: join(out, "index.js"),
});
await build({
  ...common,
  entryPoints: [join(root, "packages/dsh/src/panel.ts")],
  outfile: join(out, "panel.js"),
});

cpSync(
  join(root, "packages/transport-pi/src/bridge/mentat-bridge.ts"),
  join(out, "bridge/mentat-bridge.ts"),
);
for (const file of ["client.js", "index.js", "package.json"])
  cpSync(join(root, "packages/dsh-client", file), join(out, "dsh-client", file));
process.stdout.write(`${out}\n`);
