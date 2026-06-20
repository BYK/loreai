// Mutation testing — issue #832.
//
// Measures whether our tests CONSTRAIN behavior (not merely pass) on the
// high-risk STATEFUL modules where review — not tests — caught the recent bugs
// (sync prune-floor wedge #828, tier residue #828, decay/evict edge cases #816).
// A surviving mutant = a line the suite does not pin (sometimes an equivalent
// mutant). ALWAYS hand-verify a survivor by applying the EXACT replacement from
// the report — Stryker splits compound `A && B` conditions, so a `:col → "true"`
// mutant may be a sub-operand, not the whole condition. See
// quality/MUTATION_TESTING.md.
//
// Run nightly / on-demand; NOT per-PR (slow). No hard gate while we establish a
// baseline: `thresholds.break` is null, so the run never fails CI — we record
// the score and ratchet over time.
//
//   pnpm mutation                                          # whole allowlist (slow)
//   pnpm mutation -- --mutate "packages/core/src/sync-data.ts"   # one module
//
// See reports/mutation/index.html (and reports/mutation/mutation.json) after a run.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  // Declared explicitly: Stryker's default plugin auto-discovery globs
  // node_modules/@stryker-mutator/* and fails to resolve plugins under pnpm's
  // non-hoisted (symlinked) layout.
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  // Focused config: scopes the dry run + per-mutant runs to the sync modules'
  // direct tests so the whole thing is tractable (the full suite per mutant is
  // not). Extend its `include` when expanding `mutate` below.
  vitest: { configFile: "vitest.mutation.config.ts" },
  // perTest: map each mutant to only the tests that execute it.
  coverageAnalysis: "perTest",
  // Sync engine first — where the #828 bugs lived and the test set is clean and
  // bounded. ltm.ts / gradient.ts are next: their coverage is spread across many
  // test files, so they need a broader `include` (or the full vitest.config.ts)
  // — tracked in #832 as the follow-up expansion.
  mutate: ["packages/core/src/sync-data.ts", "packages/gateway/src/sync.ts"],
  // 4-core box → 2 concurrent vitest workers (each uses the forks pool, and the
  // test setup gives every process its own temp DB, so workers don't collide).
  concurrency: 2,
  timeoutMS: 60_000,
  timeoutFactor: 2.5,
  reporters: ["html", "clear-text", "progress", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  // No hard gate yet (#832 baseline). Scores are advisory until we ratchet.
  thresholds: { high: 80, low: 60, break: null },
  // node_modules is symlinked (not copied); keep the rest of the sandbox lean.
  ignorePatterns: [
    "dist",
    "**/dist/**",
    "dist-bin",
    "dist-tarballs",
    "dist-vendor",
    "reports",
    "coverage",
    ".stryker-tmp",
    "**/*.tsbuildinfo",
  ],
};
export default config;
