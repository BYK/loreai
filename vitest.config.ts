import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Run all packages' tests
    include: [
      "packages/core/test/**/*.test.ts",
      "packages/gateway/test/**/*.test.ts",
      "packages/opencode/test/**/*.test.ts",
      "packages/pi/test/**/*.test.ts",
    ],
    // Preload test setup for DB isolation
    setupFiles: ["./packages/core/test/setup.ts"],
    // Environment
    environment: "node",
    pool: "threads",
    // Timeouts — generous for gateway startup and LLM operations
    testTimeout: 300_000, // 5 min per test
    hookTimeout: 300_000,
    // Environment variables for test isolation
    env: {
      NODE_ENV: "test",
      SENTRY_ENABLED: "0",
      LORE_DEBUG: "0",
    },
    // Coverage is optional and run separately
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "**/*.test.ts",
        "**/test/setup.ts",
        "**/test/helpers/**",
        "**/script/**",
        "**/dist/**",
      ],
    },
    // Alias @loreai/core and @loreai/gateway for test imports
    resolve: {
      alias: {
        "@loreai/core": path.resolve(__dirname, "packages/core/src"),
        "@loreai/gateway": path.resolve(__dirname, "packages/gateway/src"),
      },
    },
  },
});
