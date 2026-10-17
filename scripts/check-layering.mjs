#!/usr/bin/env node
// Validate public package boundaries, runtime/test dependencies, and the DAG.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ALLOWED_WORKSPACE_DEPS = {
  "@mentat/core": [],
  "@mentat/benchmark": [],
  "@mentat/benchmark-file": ["@mentat/benchmark", "@mentat/evaluation"],
  "@mentat/session": ["@mentat/core"],
  "@mentat/host": [
    "@mentat/core",
    "@mentat/session",
    "@mentat/assistant",
    "@mentat/memory",
    "@mentat/memory-file",
    "@mentat/memory-mcp",
    "@mentat/observability",
    "@mentat/transport-pi",
    "@mentat/transport-acp",
  ],
  "@mentat/kernel": ["@mentat/core"],
  "@mentat/evolution": ["@mentat/core", "@mentat/kernel"],
  "@mentat/models": ["@mentat/core"],
  "@mentat/memory": [],
  "@mentat/memory-file": ["@mentat/memory"],
  "@mentat/observability": ["@mentat/core", "@mentat/session"],
  "@mentat/memory-mcp": ["@mentat/core", "@mentat/memory", "@mentat/memory-file"],
  "@mentat/memory-evolution": ["@mentat/core", "@mentat/evolution", "@mentat/memory"],
  "@mentat/evaluation": ["@mentat/core", "@mentat/evolution"],
  "@mentat/workspace": ["@mentat/core", "@mentat/evolution"],
  "@mentat/assistant": [
    "@mentat/session",
    "@mentat/core",
    "@mentat/memory",
    "@mentat/memory-file",
    "@mentat/observability",
  ],
  "@mentat/transport-pi": ["@mentat/core"],
  "@mentat/transport-acp": ["@mentat/core"],
  "@mentat/cli": [
    "@mentat/benchmark",
    "@mentat/benchmark-file",
    "@mentat/session",
    "@mentat/host",
    "@mentat/assistant",
    "@mentat/core",
    "@mentat/evaluation",
    "@mentat/evolution",
    "@mentat/kernel",
    "@mentat/memory",
    "@mentat/memory-evolution",
    "@mentat/memory-file",
    "@mentat/memory-mcp",
    "@mentat/models",
    "@mentat/observability",
    "@mentat/workspace",
    "@mentat/transport-pi",
    "@mentat/transport-acp",
  ],
};

const TEST_ONLY_DEPS = {
  "@mentat/models": ["@mentat/kernel"],
  "@mentat/memory-evolution": ["@mentat/kernel"],
};
const PURE_PACKAGES = new Set([
  "@mentat/benchmark",
  "@mentat/session",
  "@mentat/assistant",
  "@mentat/core",
  "@mentat/kernel",
  "@mentat/evolution",
  "@mentat/models",
  "@mentat/memory",
  "@mentat/memory-evolution",
]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    if (["node_modules", "dist"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(?:ts|mts|mjs|js)$/.test(name)) yield path;
  }
}

/** Read actual syntax, including re-exports, dynamic imports and import types. */
function moduleSpecifiers(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = [];
  function visit(node) {
    let spec;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      spec = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      spec = node.argument.literal;
    if (spec && ts.isStringLiteralLike(spec)) specifiers.push(spec.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

export function checkLayering(root) {
  const violations = [];
  const packagesDir = join(root, "packages");
  const packages = new Map();
  for (const dir of readdirSync(packagesDir).sort()) {
    const pkgDir = join(packagesDir, dir);
    const manifestPath = join(pkgDir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.name?.startsWith("@mentat/")) continue;
    packages.set(manifest.name, { pkgDir, manifest });
  }
  const names = [...packages.keys()].sort((a, b) => b.length - a.length);
  const graph = new Map();
  for (const [name, { pkgDir, manifest }] of packages) {
    const allowed = ALLOWED_WORKSPACE_DEPS[name];
    if (!allowed) {
      violations.push(
        `unknown package ${name}: define its responsibility and allowed dependencies`,
      );
      continue;
    }
    const declared = new Set(
      Object.keys(manifest.dependencies ?? {}).filter((dep) => dep.startsWith("@mentat/")),
    );
    const dev = new Set(
      Object.keys(manifest.devDependencies ?? {}).filter((dep) => dep.startsWith("@mentat/")),
    );
    const used = new Set();
    const production = new Set();
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== "string" || !existsSync(join(pkgDir, target))) {
        violations.push(`${name}: invalid export ${subpath}`);
      }
    }
    for (const file of walk(join(pkgDir, "src"))) {
      const test = /\.test\.[^.]+$/.test(file) || file.includes(`${sep}testing${sep}`);
      for (const alias of moduleSpecifiers(file)) {
        const label = relative(root, file);
        if (alias.startsWith(".")) {
          const target = resolve(dirname(file), alias);
          if (relative(pkgDir, target).startsWith(`..${sep}`) || target === dirname(pkgDir)) {
            violations.push(
              `${label}: cross-package relative import ${alias}; use a public export`,
            );
          }
          continue;
        }
        if (PURE_PACKAGES.has(name) && !test && isBuiltin(alias)) {
          violations.push(`${label}: ${name} must stay pure; cannot import ${alias}`);
        }
        if (!alias.startsWith("@mentat/")) continue;
        const dependency = names.find(
          (candidate) => alias === candidate || alias.startsWith(`${candidate}/`),
        );
        if (!dependency) {
          violations.push(`${label}: unknown workspace import ${alias}`);
          continue;
        }
        const subpath = alias === dependency ? "." : `.${alias.slice(dependency.length)}`;
        if (!Object.hasOwn(packages.get(dependency).manifest.exports ?? {}, subpath)) {
          violations.push(`${label}: non-public import ${alias}`);
        }
        if (dependency === name) continue;
        used.add(dependency);
        if (!test) production.add(dependency);
        if (!declared.has(dependency) && !(test && dev.has(dependency))) {
          violations.push(
            `${label}: ${dependency} is not declared for ${test ? "tests" : "production"}`,
          );
        }
      }
    }
    for (const dependency of declared) {
      if (!allowed.includes(dependency))
        violations.push(`${name}: dependency ${dependency} is not allowed`);
      if (!used.has(dependency)) violations.push(`${name}: stale dependency ${dependency}`);
    }
    for (const dependency of dev) {
      if (![...allowed, ...(TEST_ONLY_DEPS[name] ?? [])].includes(dependency)) {
        violations.push(`${name}: test dependency ${dependency} is not allowed`);
      }
      if (!used.has(dependency)) violations.push(`${name}: stale test dependency ${dependency}`);
      if (production.has(dependency) && !declared.has(dependency)) {
        violations.push(`${name}: production dependency ${dependency} is declared only for tests`);
      }
    }
    graph.set(name, used);
  }
  const done = new Set();
  const active = [];
  function visit(name) {
    if (active.includes(name)) {
      violations.push(
        `workspace cycle: ${[...active.slice(active.indexOf(name)), name].join(" -> ")}`,
      );
      return;
    }
    if (done.has(name)) return;
    active.push(name);
    for (const dep of graph.get(name) ?? []) visit(dep);
    active.pop();
    done.add(name);
  }
  for (const name of graph.keys()) visit(name);
  return { violations, packages: packages.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkLayering(root);
  if (result.violations.length) {
    console.error(
      `layering check failed:\n${result.violations.map((item) => `  ✗ ${item}`).join("\n")}\nSee docs/dev-rules/layering.md`,
    );
    process.exitCode = 1;
  } else console.log(`layering check passed (${result.packages} packages)`);
}
