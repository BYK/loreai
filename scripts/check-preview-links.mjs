#!/usr/bin/env node
/**
 * Verify that a PR-preview build (base `/_preview/pr-<n>/`) leaves NO
 * internal site-root-absolute link unprefixed.
 *
 * Why this exists:
 *   The docs are authored with site-root-absolute links (`/docs/...`).
 *   In production (base `/`) those are correct, but on PR previews the
 *   site is served from `/_preview/pr-<n>/`, so a bare `/docs/...` href
 *   404s. The `prefix-base-links` integration
 *   (packages/website/integrations/prefix-base-links.mjs) rewrites them
 *   at build time.
 *
 *   The existing `check:links` job only exercises the PRODUCTION build
 *   (base `/`), where un-prefixed links are *correct* — so a regression
 *   in the prefix integration (or a new link source it doesn't cover,
 *   e.g. a frontmatter hero link) would silently break every preview
 *   link with zero CI signal. This check closes that gap.
 *
 * What it does:
 *   1. Builds the website with a fixed sentinel `PR_NUMBER` so the build
 *      is deterministic regardless of the ambient environment.
 *   2. Scans every built HTML file for `href`/`src` attributes pointing
 *      at a site-root-absolute path.
 *   3. Fails (exit 1) listing any link that is NOT under the base prefix
 *      (excluding protocol-relative `//host` URLs, which are intentional).
 *
 * Mirrors the `check-docs` / `check-links` / `check-social` pattern:
 * self-gated, deterministic, runs in CI on every website change.
 *
 * Usage:
 *   pnpm run check:preview-links
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
// Reuse the integration's own matcher + skip predicates so this guard and the
// thing it guards can never drift apart. NOTE: this means the check is a
// CONTRACT test for the integration (href/src, double-quoted, root-absolute),
// not an independent oracle — out-of-scope forms (srcset, single-quoted attrs,
// `content="/..."`) are intentionally not validated here, just as the
// integration does not rewrite them.
import {
  INTERNAL_LINK_RE,
  isProtocolRelative,
  isUnderPrefix,
} from "../packages/website/integrations/prefix-base-links.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SITE_ROOT = resolve(import.meta.dirname, "..");
const DIST_DIR = join(SITE_ROOT, "packages/website/dist");

// Force a deterministic preview build regardless of the ambient
// environment (CI sets PR_NUMBER from the event payload; locally it is
// usually unset). A fixed sentinel keeps the expected prefix stable.
const PR_NUMBER = "0";
const BASE_PREFIX = `/_preview/pr-${PR_NUMBER}`;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildPreview() {
  console.log(
    `[check-preview-links] building preview site (PR_NUMBER=${PR_NUMBER})...`,
  );
  const result = spawnSync(
    "pnpm",
    ["--filter", "@loreai/website", "run", "build"],
    {
      cwd: SITE_ROOT,
      stdio: "inherit",
      env: { ...process.env, PR_NUMBER },
    },
  );
  if (result.status !== 0) {
    console.error("[check-preview-links] site build failed");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function listHtmlFiles(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

/** Return the list of un-prefixed internal root-absolute links in `html`. */
function findUnprefixed(html) {
  const offenders = [];
  // `matchAll` operates on an internal copy of the global regex, so the
  // shared INTERNAL_LINK_RE's lastIndex is never carried across files.
  for (const match of html.matchAll(INTERNAL_LINK_RE)) {
    const path = match[2]; // group 1 = attr name, group 2 = path
    if (isProtocolRelative(path)) continue; // `//cdn...` — intentional, skip
    if (isUnderPrefix(path, BASE_PREFIX)) continue; // correctly prefixed
    offenders.push(path);
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  buildPreview();

  const files = listHtmlFiles(DIST_DIR);
  if (files.length === 0) {
    console.error("[check-preview-links] FAIL: no HTML files found in dist/");
    process.exit(1);
  }

  const failures = [];
  for (const file of files) {
    const offenders = findUnprefixed(readFileSync(file, "utf8"));
    if (offenders.length > 0) {
      // De-dupe per file so a link repeated on a page reports once.
      failures.push({
        relPath: relative(DIST_DIR, file),
        offenders: [...new Set(offenders)],
      });
    }
  }

  if (failures.length > 0) {
    const total = failures.reduce((n, f) => n + f.offenders.length, 0);
    console.error(
      `[check-preview-links] FAIL: ${total} un-prefixed internal link(s) ` +
        `in ${failures.length} page(s).\n` +
        `Every internal root-absolute link must be prefixed with ` +
        `"${BASE_PREFIX}" on preview builds — see ` +
        `packages/website/integrations/prefix-base-links.mjs.`,
    );
    for (const { relPath, offenders } of failures) {
      console.error(`  ${relPath}:`);
      for (const path of offenders) console.error(`    - ${path}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-preview-links] OK: ${files.length} page(s); all internal ` +
      `root-absolute links prefixed with "${BASE_PREFIX}".`,
  );
}

try {
  main();
} catch (err) {
  console.error("[check-preview-links] unexpected error:", err);
  process.exit(1);
}
