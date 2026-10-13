import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./scripts/workspace-aliases.mjs";

export default defineConfig({
  resolve: {
    // Generated from each package.json `exports` by scripts/gen-aliases.mjs.
    alias: workspaceAliases,
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
