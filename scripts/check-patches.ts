#!/usr/bin/env tsx
/**
 * Verify Sentry pnpm patches are effective.
 *
 * Checks that the @sentry/node patch correctly strips unused integration
 * modules from the installed (patched) package. This prevents a Sentry
 * version bump from silently dropping the patch and re-inflating the bundle.
 *
 * Usage:
 *   pnpm tsx scripts/check-patches.ts
 *
 * Gated in CI via the "check-patches" job.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayDir = join(rootDir, "packages", "gateway");

// Resolve the @sentry/node CJS barrel that esbuild will actually use.
// The sentryNodePlugin in bundle.ts does: @sentry/bun -> @sentry/node.
const sentryBunEntry = createRequire(`${gatewayDir}/`).resolve("@sentry/bun");
const sentryNodeEntry = createRequire(`${sentryBunEntry}/`).resolve(
  "@sentry/node",
);
const sentryNodeDir = dirname(sentryNodeEntry);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;
const fileCache = new Map<string, string>();

function readCached(filePath: string): string {
  let content = fileCache.get(filePath);
  if (content === undefined) {
    content = readFileSync(filePath, "utf8");
    fileCache.set(filePath, content);
  }
  return content;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failures++;
  } else {
    console.log(`  ok: ${message}`);
  }
}

function label(filePath: string): string {
  return filePath.split("@sentry/node/")[1] ?? filePath;
}

function assertNotInFile(filePath: string, markers: string[]): void {
  const content = readCached(filePath);
  for (const marker of markers) {
    assert(
      !content.includes(marker),
      `${label(filePath)} must not contain "${marker}"`,
    );
  }
}

function assertInFile(filePath: string, markers: string[]): void {
  const content = readCached(filePath);
  for (const marker of markers) {
    assert(
      content.includes(marker),
      `${label(filePath)} must contain "${marker}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Structural assertion: sentryNodeDir must end with build/cjs
// ---------------------------------------------------------------------------
assert(
  sentryNodeDir.endsWith("/build/cjs"),
  `resolved @sentry/node entry is under build/cjs/ (got: ${sentryNodeDir})`,
);

// ---------------------------------------------------------------------------
// 1. CJS barrel: must NOT require() stripped integration modules
// ---------------------------------------------------------------------------
console.log("\n@sentry/node CJS barrel (build/cjs/index.js):");

const cjsBarrel = join(sentryNodeDir, "index.js");

// Own integration modules that should be stripped from the CJS barrel.
// Each marker uses a trailing delimiter (/ or .) to avoid substring
// false-positives (e.g. "mysql" matching "mysql2", "mongo" matching "mongoose").
const strippedOwnModules = [
  // Framework/DB integrations
  "./integrations/tracing/express.",
  "./integrations/tracing/fastify/",
  "./integrations/tracing/graphql/",
  "./integrations/tracing/kafka/",
  "./integrations/tracing/lrumemoizer/",
  "./integrations/tracing/mongo/",
  "./integrations/tracing/mongoose/",
  "./integrations/tracing/mysql/",
  "./integrations/tracing/mysql2/",
  "./integrations/tracing/redis/",
  "./integrations/tracing/postgres/",
  "./integrations/tracing/postgresjs.",
  "./integrations/tracing/prisma/",
  "./integrations/tracing/hapi/",
  "./integrations/tracing/hono/",
  "./integrations/tracing/koa/",
  "./integrations/tracing/connect/",
  "./integrations/tracing/knex/",
  "./integrations/tracing/tedious/",
  "./integrations/tracing/genericPool/",
  "./integrations/tracing/dataloader/",
  "./integrations/tracing/amqplib/",
  "./integrations/tracing/firebase/",
  // AI tracing integrations
  "./integrations/tracing/vercelai/",
  "./integrations/tracing/openai/",
  "./integrations/tracing/anthropic-ai/",
  "./integrations/tracing/google-genai/",
  "./integrations/tracing/langchain/",
  "./integrations/tracing/langgraph/",
  // Feature flag shims
  "./integrations/featureFlagShims/",
  // FS integration
  "./integrations/fs/",
];
assertNotInFile(cjsBarrel, strippedOwnModules);

// Must still have essential modules
assertInFile(cjsBarrel, [
  "./integrations/http.js",
  "./integrations/node-fetch/",
  "./sdk/index.js",
  "@sentry/core",
  "@sentry/node-core",
]);

// ESM barrel is intentionally NOT patched — re-export chains from
// @sentry/bun -> @sentry/node -> @sentry/core must remain intact
// for the test environment (which uses raw ESM imports, not bundled).
// Assert that the ESM barrel still exports a known stripped symbol
// to confirm it remains unpatched.
console.log("\n@sentry/node ESM barrel (build/esm/index.js):");
const esmBarrel = join(sentryNodeDir, "..", "esm", "index.js");
assertInFile(esmBarrel, ["expressIntegration"]);

// ---------------------------------------------------------------------------
// 2. tracing/index.js: must NOT import heavy integration modules
// ---------------------------------------------------------------------------
console.log("\n@sentry/node tracing/index.js (CJS + ESM):");

// sentryNodeDir = .../build/cjs, so tracing/index.js is a subdirectory
const cjsTracingIndex = join(
  sentryNodeDir,
  "integrations",
  "tracing",
  "index.js",
);

// ESM lives at build/esm/ (sibling of build/cjs/)
const esmTracingIndex = join(
  sentryNodeDir,
  "..",
  "esm",
  "integrations",
  "tracing",
  "index.js",
);

// Check both CJS and ESM tracing/index.js with the same marker list.
// These are the integration names that getAutoPerformanceIntegrations()
// originally called — none should remain after patching.
const tracingMarkers = [
  "expressIntegration",
  "fastifyIntegration",
  "mongoIntegration",
  "redisIntegration",
  "kafkaIntegration",
  "prismaIntegration",
  "openAIIntegration",
  "vercelAIIntegration",
  "langChainIntegration",
  "langGraphIntegration",
  "firebaseIntegration",
];

for (const file of [cjsTracingIndex, esmTracingIndex]) {
  assertNotInFile(file, tracingMarkers);
  // Must still export the function names (gutted to return empty arrays)
  assertInFile(file, [
    "getAutoPerformanceIntegrations",
    "getOpenTelemetryInstrumentationToPreload",
  ]);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log();
if (failures > 0) {
  console.error(
    `${failures} assertion(s) failed — the @sentry/node patch may be broken or outdated.`,
  );
  console.error(
    "Regenerate: pnpm patch @sentry/node@<version>, apply changes, pnpm patch-commit.",
  );
  process.exit(1);
} else {
  console.log("All patch assertions passed.");
}
