#!/usr/bin/env node
// Enforce the layering invariants documented in docs/dev-rules/layering.md.
//
//   1. @mentat/core:            zero workspace deps, no `node:` imports (pure engine)
//   2. transport-*:             only @mentat/core
//   3. @mentat/runtime:         only @mentat/core (engine-agnostic: no transport)
//   4. @mentat/memory:          only @mentat/core
//   5. @mentat/cli:             may depend on core / memory / runtime / transport-*
//
// It also checks that declared workspace dependencies and actual `@mentat/*`
// imports agree, so a stale dependency (the old `iterate → transport-pi`) or a
// missing one fails the check.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const ALLOWED_WORKSPACE_DEPS = {
  "@mentat/core": [],
  "@mentat/memory": ["@mentat/core"],
  "@mentat/runtime": ["@mentat/core"],
  "@mentat/transport-pi": ["@mentat/core"],
  "@mentat/transport-acp": ["@mentat/core"],
  "@mentat/cli": [
    "@mentat/core",
    "@mentat/memory",
    "@mentat/runtime",
    "@mentat/transport-pi",
    "@mentat/transport-acp",
  ],
};

const violations = [];
const fail = (message) => violations.push(message);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|mjs)$/.test(name)) yield path;
  }
}

const packages = readdirSync(packagesDir)
  .map((pkgDir) => {
    const manifestPath = join(packagesDir, pkgDir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return undefined;
    }
    return manifest.name?.startsWith("@mentat/") ? { pkgDir, manifest } : undefined;
  })
  .filter(Boolean);

const names = new Set(packages.map((pkg) => pkg.manifest.name));

for (const { pkgDir, manifest } of packages) {
  const allowed = ALLOWED_WORKSPACE_DEPS[manifest.name];
  if (!allowed) {
    fail(`unknown package ${manifest.name}: add it to ALLOWED_WORKSPACE_DEPS`);
    continue;
  }

  const declared = new Set(
    Object.keys(manifest.dependencies ?? {}).filter((dep) => names.has(dep)),
  );
  const used = new Set();
  let hasNodeImport = false;

  for (const file of walk(join(packagesDir, pkgDir, "src"))) {
    const source = readFileSync(file, "utf8");
    if (/(?:from|import)\s*\(?["']node:/.test(source)) hasNodeImport = true;
    for (const match of source.matchAll(/["'](@mentat\/[^"']+)["']/g)) {
      const alias = match[1];
      for (const name of names) {
        // A package importing its own subpath (e.g. @mentat/core/testing from
        // within @mentat/core) is not a dependency.
        if (name === manifest.name) continue;
        if (alias === name || alias.startsWith(`${name}/`)) used.add(name);
      }
    }
  }

  for (const dep of declared) {
    if (!allowed.includes(dep)) {
      fail(`${manifest.name}: declared dependency "${dep}" is not allowed by the layering rules`);
    }
    if (!used.has(dep)) {
      fail(`${manifest.name}: stale dependency "${dep}" is declared but never imported`);
    }
  }
  for (const dep of used) {
    if (!declared.has(dep)) {
      fail(`${manifest.name}: uses "${dep}" but does not declare it in package.json`);
    }
  }

  if (manifest.name === "@mentat/core") {
    if (declared.size > 0) fail("@mentat/core must not depend on any workspace package");
    if (hasNodeImport) fail("@mentat/core must stay pure: no `node:` imports allowed");
  }
}

if (violations.length > 0) {
  console.error("layering check failed:\n");
  for (const violation of violations) console.error(`  ✗ ${violation}`);
  console.error("\nSee docs/dev-rules/layering.md");
  process.exit(1);
}

console.log(`layering check passed (${packages.length} packages)`);
