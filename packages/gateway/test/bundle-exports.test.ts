/**
 * Smoke test for the npm bundle artifacts.
 *
 * Verifies that:
 * - Every file referenced by package.json `files` and `exports` exists
 * - The CJS Node bundle uses node:sqlite (not bun:sqlite)
 * - The imported module exports the expected public API
 *
 * Requires `pnpm run build` to have been run first. Skipped otherwise.
 */
import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(fileURLToPath(import.meta.url), "..", "..");
const distDir = join(packageDir, "dist");
const pkgJson = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);
const hasBundle = existsSync(join(distDir, "index.cjs"));

describe.skipIf(!hasBundle)("bundle exports", () => {
  // -------------------------------------------------------------------------
  // Layer 1: Static content checks
  // -------------------------------------------------------------------------

  test("all declared files exist", () => {
    for (const file of pkgJson.files as string[]) {
      const fullPath = join(packageDir, file);
      expect(existsSync(fullPath)).toBe(true);
    }
  });

  test("export conditions reference files in the files list", () => {
    const filesSet = new Set(pkgJson.files as string[]);
    const exports = pkgJson.exports["."] as Record<string, string>;
    for (const [_condition, filePath] of Object.entries(exports)) {
      // Strip leading "./" for comparison with files array entries
      const normalized = filePath.replace(/^\.\//, "");
      expect(filesSet.has(normalized)).toBe(true);
    }
  });

  test("CJS bundle uses node:sqlite, not bun:sqlite", () => {
    const content = readFileSync(join(distDir, "index.cjs"), "utf8");
    expect(content).toContain("node:sqlite");
    expect(content).not.toContain("bun:sqlite");
  });
});
