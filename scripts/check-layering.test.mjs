import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLayering } from "./check-layering.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mentat-layering-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function pkg(name, source = "export {};", dependencies = {}, devDependencies = {}) {
    const dir = join(root, "packages", name, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), source);
    writeFileSync(
      join(dir, "..", "package.json"),
      JSON.stringify({
        name: `@mentat/${name}`,
        exports: { ".": "./src/index.ts" },
        dependencies,
        devDependencies,
      }),
    );
    return dir;
  }
  return { root, pkg, check: () => checkLayering(root).violations };
}

test("accepts declared public dependencies and ignores import-like comments", (t) => {
  const f = fixture(t);
  f.pkg("core", '/* import "@mentat/not-real" */ export const value = 1;');
  f.pkg("kernel", 'import { value } from "@mentat/core";', { "@mentat/core": "workspace:*" });
  assert.deepEqual(f.check(), []);
});

test("rejects undeclared workspace imports and forbidden dependency directions", (t) => {
  const f = fixture(t);
  f.pkg("core");
  f.pkg("memory", 'import "@mentat/core";');
  assert.match(f.check().join("\n"), /not declared/);
  f.pkg("memory", 'import "@mentat/core";', { "@mentat/core": "workspace:*" });
  assert.match(f.check().join("\n"), /not allowed/);
});

test("rejects private subpaths and cross-package relative imports", (t) => {
  const f = fixture(t);
  f.pkg("core");
  f.pkg("kernel", 'import "@mentat/core/src/types"; import "../../core/src/index";', {
    "@mentat/core": "workspace:*",
  });
  const violations = f.check().join("\n");
  assert.match(violations, /non-public import/);
  assert.match(violations, /cross-package relative import/);
});

test("finds cycles rather than accepting locally declared dependency edges", (t) => {
  const f = fixture(t);
  f.pkg("core", 'import "@mentat/kernel";', { "@mentat/kernel": "workspace:*" });
  f.pkg("kernel", 'import "@mentat/core";', { "@mentat/core": "workspace:*" });
  assert.match(f.check().join("\n"), /workspace cycle:/);
});

test("pure packages cannot import Node via static, dynamic, require or import-type syntax", (t) => {
  const f = fixture(t);
  f.pkg(
    "memory",
    'import "fs"; import("node:path"); require("node:crypto"); type X = import("node:fs").Stats;',
  );
  assert.equal(f.check().filter((v) => v.includes("must stay pure")).length, 4);
});

test("keeps test-only dependencies out of production and detects unused declarations", (t) => {
  const f = fixture(t);
  f.pkg("core");
  f.pkg("kernel", 'import "@mentat/core";', { "@mentat/core": "workspace:*" });
  const dir = f.pkg(
    "models",
    'import "@mentat/core";',
    { "@mentat/core": "workspace:*" },
    { "@mentat/kernel": "workspace:*" },
  );
  writeFileSync(join(dir, "artifact.test.ts"), 'import "@mentat/kernel"; import "node:fs";');
  assert.deepEqual(f.check(), []);
  writeFileSync(join(dir, "index.ts"), 'import "@mentat/core"; import "@mentat/kernel";');
  assert.match(f.check().join("\n"), /declared only for tests/);
  f.pkg("models", "export {};", { "@mentat/core": "workspace:*" });
  assert.match(f.check().join("\n"), /stale dependency/);
});

test("rejects imports of unknown packages and broken export targets", (t) => {
  const f = fixture(t);
  const dir = f.pkg("core", 'import "@mentat/missing";');
  writeFileSync(
    join(dir, "..", "package.json"),
    JSON.stringify({ name: "@mentat/core", exports: { ".": "./missing.ts" } }),
  );
  const violations = f.check().join("\n");
  assert.match(violations, /unknown workspace import/);
  assert.match(violations, /invalid export/);
});
