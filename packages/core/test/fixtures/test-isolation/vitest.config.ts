import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import rootConfig from "../../../../../vitest.config";

const rootTestConfig = rootConfig.test ?? {};
const globalSetup = Array.isArray(rootTestConfig.globalSetup)
  ? rootTestConfig.globalSetup
  : rootTestConfig.globalSetup
    ? [rootTestConfig.globalSetup]
    : [];
const recreateAfterCleanup = resolve(__dirname, "recreate-after-cleanup.ts");
const earlyProcessExit = resolve(__dirname, "early-process-exit.ts");
const fixtureGlobalSetup = globalSetup.flatMap((entry) =>
  String(entry).endsWith("packages/core/test/global-setup.ts")
    ? [recreateAfterCleanup, entry, earlyProcessExit]
    : [entry],
);

export default defineConfig({
  ...rootConfig,
  test: {
    ...rootTestConfig,
    setupFiles:
      process.env.LORE_TEST_ISOLATION_EVAL_SETUP === "1"
        ? ["./packages/core/eval/setup.ts"]
        : rootTestConfig.setupFiles,
    include: ["packages/core/test/fixtures/test-isolation/**/*.fixture.ts"],
    globalSetup: [
      ...fixtureGlobalSetup,
      resolve(__dirname, "observe-test-root.ts"),
    ],
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      ...rootTestConfig.sequence,
      hooks:
        process.env.LORE_TEST_ISOLATION_HOOKS === "list" ? "list" : "stack",
    },
  },
});
