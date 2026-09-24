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
const sentryServerUtilsEntry = createRequire(`${sentryNodeEntry}/`).resolve(
  "@sentry/server-utils",
);

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

// Optional integrations that should be stripped from the CJS barrel.
const strippedOwnModules = [
  "./integrations/fs/index.js",
  "./integrations/tracing/hapi.js",
  "./integrations/tracing/koa.js",
  "./integrations/featureFlagShims/",
  "./eve.js",
  "SentryMastraExporter",
  "expressIntegration",
  "fastifyIntegration",
  "eveInstrumentation",
];
assertNotInFile(cjsBarrel, strippedOwnModules);

// Must still have essential modules
assertInFile(cjsBarrel, [
  "./integrations/http/index.js",
  "./integrations/node-fetch/",
  "./sdk/index.js",
  "@sentry/core",
  "@sentry/opentelemetry",
]);

// Node v11 moved optional integrations into @sentry/server-utils. Its CJS
// barrel is narrowed to the two helpers required by the Node SDK runtime.
console.log("\n@sentry/server-utils CJS barrel:");
assertInFile(sentryServerUtilsEntry, [
  "setAsyncLocalStorageAsyncContextStrategy",
  "detectOrchestrionSetup",
]);
assertNotInFile(sentryServerUtilsEntry, [
  "./integrations/index.js",
  "getErrorIntegrations",
  "getTracingIntegrations",
  "SentryMastraExporter",
]);

// SDK defaults retain Sentry's base Node integrations but do not load
// framework and database integrations that Lore does not use.
console.log("\n@sentry/node SDK defaults:");
const cjsSdkIndex = join(sentryNodeDir, "sdk", "index.js");
assertInFile(cjsSdkIndex, ["modules.modulesIntegration()"]);
assertNotInFile(cjsSdkIndex, [
  "getErrorIntegrations",
  "getTracingIntegrations",
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

for (const file of [cjsTracingIndex, esmTracingIndex]) {
  assertNotInFile(file, ["@sentry/server-utils", "getTracingIntegrations"]);
  assertInFile(file, ["getAutoPerformanceIntegrations", "return []"]);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log();
if (failures > 0) {
  console.error(
    `${failures} assertion(s) failed — a Sentry v11 patch may be broken or outdated.`,
  );
  console.error(
    "Regenerate with pnpm patch / pnpm patch-commit for @sentry/node and @sentry/server-utils.",
  );
  process.exit(1);
} else {
  console.log("All patch assertions passed.");
}
