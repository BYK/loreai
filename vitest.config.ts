import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Alias @loreai/core and @loreai/gateway for test imports.
  // MUST be at the top level of the vite config — putting this under
  // `test.resolve.alias` does NOT work (vite's resolver is a top-level
  // option, not a test.* option). The previous placement silently
  // resolved to the stale dist build, masking real test failures.
  resolve: {
    alias: {
      "@loreai/core": path.resolve(__dirname, "packages/core/src"),
      "@loreai/gateway": path.resolve(__dirname, "packages/gateway/src"),
    },
  },
  test: {
    // Run all packages' tests
    include: [
      "packages/core/test/**/*.test.ts",
      "packages/gateway/test/**/*.test.ts",
      "packages/opencode/test/**/*.test.ts",
    ],
    // Preload test setup for DB isolation
    setupFiles: ["./packages/core/test/setup.ts"],
    // Environment
    environment: "node",
    pool: "forks",
    // Timeouts — generous for gateway startup and LLM operations
    testTimeout: 300_000, // 5 min per test
    hookTimeout: 300_000,
    // Environment variables for test isolation
    env: {
      NODE_ENV: "test",
      SENTRY_ENABLED: "0",
      LORE_DEBUG: "0",
    },
    // Coverage is optional and run separately. `lcov` is required for the
    // Codecov upload in CI; text/json/html are kept for local inspection.
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: [
        "**/*.test.ts",
        "**/test/setup.ts",
        "**/test/helpers/**",
        "**/script/**",
        "**/dist/**",
        // Non-tested / non-source packages — keep them out of the report so
        // they don't drag down or pollute patch coverage. Only core, gateway,
        // and opencode have tests.
        "packages/website/**",
        "packages/pi/**",
        "**/eval/**",
        "**/*.eval.ts",
        "*.config.ts",
        "scripts/**",
      ],
    },
  },
});
