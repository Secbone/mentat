import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mentat/core/testing": fileURLToPath(
        new URL("./packages/core/src/testing/contract.ts", import.meta.url),
      ),
      "@mentat/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@mentat/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
