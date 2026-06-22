import path from "node:path";
import { defineConfig } from "vitest/config";

// Focused Vitest config for Stryker mutation runs (issue #832).
//
// Mutation testing re-runs the suite once per mutant, so scoping to ONLY the
// tests that exercise the mutated module keeps it tractable — the full 3.5k-test
// suite per mutant is not. Mirrors vitest.config.ts (alias → src, DB-isolation
// setup) but narrows `include` to the SYNC modules' direct tests.
//
// When you add a module to `mutate` in stryker.config.mjs, add its covering
// test files here too, or its mutants will all "survive" (no test runs them).
export default defineConfig({
  resolve: {
    alias: {
      "@loreai/core": path.resolve(__dirname, "packages/core/src"),
      "@loreai/gateway": path.resolve(__dirname, "packages/gateway/src"),
    },
  },
  test: {
    include: [
      "packages/core/test/sync-data.test.ts",
      "packages/core/test/sync-registry-contract.test.ts",
      "packages/gateway/test/sync.test.ts",
      // Covering tests for packages/gateway/src/translate/bedrock.ts.
      "packages/gateway/test/bedrock.test.ts",
      "packages/gateway/test/bedrock.property.test.ts",
      "packages/gateway/test/bedrock-stream.test.ts",
    ],
    setupFiles: ["./packages/core/test/setup.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: "test", SENTRY_ENABLED: "0", LORE_DEBUG: "0" },
  },
});
