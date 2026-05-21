import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/core/eval/**/*.eval.ts"],
    // Evals are slow — generous timeouts for gateway startup, session replay,
    // and multi-pass compaction at 2.3M tokens.
    testTimeout: 600_000, // 10 min per test
    hookTimeout: 1_800_000, // 30 min for beforeAll (session replay)
    reporters: ["vitest-evals/reporter", "default"],
    // Single-threaded — evals share a gateway process and temp DB.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
