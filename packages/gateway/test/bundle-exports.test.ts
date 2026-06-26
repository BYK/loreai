/**
 * Smoke test for the npm bundle artifacts.
 *
 * Verifies that:
 * - Every file referenced by package.json `files` and `exports` exists
 * - The CJS Node bundle uses node:sqlite (not bun:sqlite)
 * - The imported module exports the expected public API
 *
 * Requires the bundle (`pnpm --filter @loreai/gateway run bundle`) to have
 * been built. The root `pretest` script runs the bundle automatically before
 * `pnpm test`, so this test runs in every environment (local + CI). The
 * skipIf guard is defensive — it should never trigger in normal use, but
 * ensures a missing bundle is reported as a skip rather than a confusing
 * file-not-found assertion failure.
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

  // -------------------------------------------------------------------------
  // Layer 2: Externalized workspace imports must be runtime dependencies
  // (regression guard for issue #998)
  // -------------------------------------------------------------------------

  test("externalized @loreai/* imports in the Bun bundle are runtime deps", () => {
    // The Bun ESM bundle keeps @loreai/core external on purpose (see
    // script/bundle.ts) so the plugin and the in-process gateway share one
    // module instance of @loreai/core. For that external import to resolve in
    // published / standalone installs (e.g. OpenCode's embedded Bun loading
    // the plugin directly), every externalized @loreai/* package MUST be a
    // runtime dependency — not a devDependency, which consumers never install.
    // Issue #998 regressed exactly this: @loreai/core was external + devDep.
    const content = readFileSync(join(distDir, "index.bun.js"), "utf8");

    // Dev shim (`export * from "../src/index.ts";`) does not exercise the
    // externalized-core artifact, so there is nothing to assert. The real
    // minified bundle is present under `pnpm test` because the root `pretest`
    // runs `pnpm --filter @loreai/gateway run bundle`.
    if (content.trimStart().startsWith("export *")) return;

    // Match import CONTEXTS only — static `from "@loreai/x"` and dynamic
    // `import("@loreai/x")`. A bare-string scan would false-match the bundle's
    // embedded package.json (self-name "@loreai/gateway") and the doctor/setup
    // string literals mentioning "@loreai/opencode"; requiring those as deps
    // would be a self-dependency or a dependency cycle.
    const importContext = /(?:from|import)\s*\(?\s*["'](@loreai\/[\w-]+)["']/g;
    const specifiers = new Set<string>();
    for (const match of content.matchAll(importContext)) {
      specifiers.add(match[1]);
    }

    // Non-vacuous guard: @loreai/core is externalized by design (the shared
    // _originalFetch invariant), so the scan must actually find it. If this
    // ever fails, either the bundle stopped externalizing core (revisit the
    // fetch-loop invariant in script/bundle.ts) or the regex needs updating.
    expect(specifiers.has("@loreai/core")).toBe(true);

    const deps = (pkgJson.dependencies ?? {}) as Record<string, string>;
    for (const specifier of specifiers) {
      expect(
        deps[specifier],
        `${specifier} is externalized in index.bun.js and must be declared in "dependencies"`,
      ).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Dependency manifest invariants (regression guards for issue #998)
//
// These are bundle-independent — they assert the package.json manifests
// directly, so they run in every environment (including dev checkouts where
// only the bun shim exists).
// ---------------------------------------------------------------------------

describe("dependency manifest invariants (#998)", () => {
  test("@loreai/core is a runtime dependency, not a devDependency", () => {
    // The on-disk source manifest — NOT the copy embedded in the bundle text.
    expect(pkgJson.dependencies?.["@loreai/core"]).toBeDefined();
    expect(pkgJson.devDependencies?.["@loreai/core"]).toBeUndefined();
  });

  // Internal packages each consumer imports at RUNTIME. #998 happened in the
  // plugin's dependency chain (@loreai/opencode → @loreai/gateway → external
  // @loreai/core), so presence — not just spec correctness — is asserted for
  // every link. devDependencies are never installed for a transitively-
  // consumed published package, which is exactly how #998 manifested.
  const requiredInternalDeps: Record<string, string[]> = {
    gateway: ["@loreai/core"],
    opencode: ["@loreai/core", "@loreai/gateway"],
    pi: ["@loreai/core", "@loreai/gateway"],
  };

  test("internal @loreai/* deps are present runtime deps, never devDeps", () => {
    for (const [name, required] of Object.entries(requiredInternalDeps)) {
      const manifest = JSON.parse(
        readFileSync(join(packageDir, "..", name, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = manifest.dependencies ?? {};
      const devDeps = manifest.devDependencies ?? {};

      // (a) Every internal package consumed at runtime MUST be a declared
      //     runtime dependency. This is the core #998 invariant: the package
      //     that exhibited the bug (@loreai/opencode) is presence-checked, not
      //     merely spec-checked, so moving a link back into devDependencies
      //     fails here even if no externalized-import scan covers it.
      for (const dep of required) {
        expect(
          deps[dep],
          `${manifest.name} consumes ${dep} at runtime; it MUST be in "dependencies"`,
        ).toBeDefined();
      }

      // (b) No internal @loreai/* package may hide in devDependencies — that
      //     is the exact shape of #998 (runtime use + devDependency declaration).
      for (const dep of Object.keys(devDeps)) {
        expect(
          dep.startsWith("@loreai/"),
          `${manifest.name} declares ${dep} in devDependencies; internal @loreai/* packages must be runtime deps (#998)`,
        ).toBe(false);
      }
    }
  });

  test("internal @loreai/* deps use workspace:* across gateway, opencode, pi", () => {
    // A single shared @loreai/core instance is only guaranteed when every
    // consumer references the internal packages at the same version.
    // `workspace:*` is rewritten to the exact release version at `pnpm pack`
    // time, keeping all packages unified per release. A pinned/divergent
    // version could install two @loreai/core copies → two _originalFetch
    // values → infinite fetch loop (gateway → interceptor → gateway → …).
    for (const name of Object.keys(requiredInternalDeps)) {
      const manifest = JSON.parse(
        readFileSync(join(packageDir, "..", name, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
      };
      const deps = manifest.dependencies ?? {};
      for (const [dep, spec] of Object.entries(deps)) {
        if (dep.startsWith("@loreai/")) {
          expect(spec, `${manifest.name} → ${dep}`).toBe("workspace:*");
        }
      }
    }
  });
});
