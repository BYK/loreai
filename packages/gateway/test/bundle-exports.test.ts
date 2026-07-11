/**
 * Smoke test for the npm bundle artifacts.
 *
 * Verifies that:
 * - Every file referenced by package.json `files` and `exports` exists
 * - The CJS Node bundle uses node:sqlite (not bun:sqlite)
 * - @loreai/core is inlined (not externalized) in the Bun bundle (#1027)
 *
 * These assert on the built `dist/` artifacts. A bundle build runs immediately
 * before vitest under `pnpm test` (root `pretest` hook) and `pnpm run
 * test:coverage` (its own `bundle &&` chain, used by CI) — but NOT for
 * `vitest --watch`, IDE test runners, or a direct `vitest run`. After pulling a
 * change to the bundle's inputs (e.g. #1027 inlining @loreai/core) WITHOUT
 * rebuilding, those launch paths would otherwise assert against a stale/missing
 * artifact that no longer reflects source — the "bundle-export tests are
 * failing on latest main" trap.
 *
 * Rather than SKIP when the artifact is stale/missing (which silently drops
 * these checks in the local dev loop — a footgun), the suite REBUILDS the
 * bundle on demand in `beforeAll`, so it always runs against a bundle built
 * from current source no matter how vitest was launched. The rebuild is gated
 * on freshness, so it is a no-op when the bundle is already current: CI builds
 * the bundle as the last step before vitest (after checkout/build/typecheck/
 * lint) and a manual `pnpm run bundle` leaves it newer than every source —
 * neither triggers a redundant rebuild.
 *
 * The rebuild wipes + recreates `dist/`, but nothing else reads `dist/` during
 * a test run: vitest's top-level `resolve.alias` (vitest.config.ts) redirects
 * every `@loreai/*` import — including the variable dynamic imports in
 * gateway-smoke and the opencode plugin — to `src`, and core's worker_threads
 * resolve to their `.ts` siblings under vitest, never `dist/`. With
 * `pool: "forks"` on top, the rebuild cannot race another test file.
 */
import { beforeAll, describe, test, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = join(packageDir, "..", "..");
const distDir = join(packageDir, "dist");
const coreSrcDir = join(packageDir, "..", "core", "src");
const pkgJson = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);

const cjsBundlePath = join(distDir, "index.cjs");
const bunBundlePath = join(distDir, "index.bun.js");

/** Newest mtime (ms) across the given files/directories; dirs walk recursively.
 *  Unreadable files/dirs are skipped rather than crashing the walk. */
function newestMtimeMs(roots: string[]): number {
  let newest = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const p = stack.pop() as string;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const entry of readdirSync(p)) stack.push(join(p, entry));
      } catch {
        // Unreadable directory — skip it rather than crash the walk.
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

/** Oldest mtime (ms) across the given files; a missing file counts as 0. */
function oldestMtimeMs(files: string[]): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const f of files) {
    try {
      oldest = Math.min(oldest, statSync(f).mtimeMs);
    } catch {
      return 0;
    }
  }
  return Number.isFinite(oldest) ? oldest : 0;
}

// The bundle is fresh iff both asserted artifacts exist and are strictly newer
// than every source the bundle is built from:
//   - gateway/src + core/src — both inlined into the bundle;
//   - script/ — the whole build-script dir, since bundle.ts imports siblings
//     (the ORT plugins, debug-id, import-meta-url); tracking only bundle.ts
//     would miss a build change made in one of those and falsely report fresh;
//   - package.json — drives the files/exports/deps assertions.
// Dependency upgrades (node_modules / the ORT wasm) are intentionally NOT
// tracked here — those arrive via `pnpm install`, whose postinstall rebuilds the
// bundle. Ties resolve toward rebuilding (strict `>`): a rebuild is cheap and
// always correct, so err on that side rather than risk asserting against a
// same-timestamp stale artifact.
function isBundleFresh(): boolean {
  const newestSource = newestMtimeMs([
    join(packageDir, "src"),
    coreSrcDir,
    join(packageDir, "script"),
    join(packageDir, "package.json"),
  ]);
  const oldestArtifact = oldestMtimeMs([cjsBundlePath, bunBundlePath]);
  return oldestArtifact > 0 && oldestArtifact > newestSource;
}

describe("bundle exports", () => {
  // Build the bundle from current source when it is missing or stale, so the
  // assertions below never run against an artifact that predates source (see
  // the file header for why skipping would be a local footgun). No-op when the
  // bundle is already fresh — CI's pre-vitest bundle build and a manual
  // `pnpm run bundle` both leave it newer than every source, so this never
  // double-builds.
  beforeAll(() => {
    if (isBundleFresh()) return;
    process.stderr.write(
      "[bundle-exports] dist/ bundle missing or stale — building it " +
        "(pnpm --filter @loreai/gateway run bundle)…\n",
    );
    try {
      // execSync goes through the platform shell (a fixed literal command, no
      // interpolation), so it resolves `pnpm.cmd` on Windows — execFile("pnpm")
      // would ENOENT there because a .cmd is not directly executable.
      execSync("pnpm --filter @loreai/gateway run bundle", {
        cwd: repoRoot,
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        "Failed to build the @loreai/gateway bundle required by " +
          "bundle-exports.test.ts. Run `pnpm --filter @loreai/gateway run " +
          "bundle` to reproduce.\n" +
          `${e.stderr ?? ""}${e.stdout ?? ""}${e.message ?? String(err)}`,
      );
    }
  }, 300_000);

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

  test("@loreai/core is inlined (not externalized) in the Bun bundle (#1027)", () => {
    // The Bun ESM bundle now INLINES @loreai/core (see script/bundle.ts): the
    // shared-original-fetch invariant moved to a Symbol.for process-global, so
    // multiple core copies in one process are safe and there is no longer a
    // reason to keep core external. Inlining is what lets us drop the
    // external-core runtime dep and its ~480 MB ML tree (#1024/#1026).
    const content = readFileSync(join(distDir, "index.bun.js"), "utf8");

    // Defensive: the `beforeAll` above guarantees a freshly-built (real,
    // minified) bundle, so this dev-shim (`export * from "../src/index.ts"`)
    // branch is normally unreachable. Kept so a hand-placed shim degrades to a
    // no-op assert instead of scanning re-export syntax.
    if (content.trimStart().startsWith("export *")) return;

    // Match import CONTEXTS only — static `from "@loreai/x"` and dynamic
    // `import("@loreai/x")`. A bare-string scan would false-match the bundle's
    // embedded package.json (self-name "@loreai/gateway") and the doctor/setup
    // string literals mentioning "@loreai/opencode".
    const importContext = /(?:from|import)\s*\(?\s*["'](@loreai\/[\w-]+)["']/g;
    const specifiers = new Set<string>();
    for (const match of content.matchAll(importContext)) {
      specifiers.add(match[1]);
    }

    // Non-vacuous guard: core must be INLINED — the scan must NOT find it as an
    // import specifier. If this fails, the bundle regressed to externalizing
    // core, which would reintroduce the external-core runtime dependency and
    // the shared-instance fetch-loop concern (revisit script/bundle.ts +
    // fetch-interceptor.ts's Symbol.for global before changing this).
    expect(specifiers.has("@loreai/core")).toBe(false);

    // Any @loreai/* that IS still externalized (none today) must be a declared
    // runtime dependency so it resolves in published installs (the #998 shape).
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

describe("dependency manifest invariants (#998, #1027)", () => {
  test("@loreai/core is a build-only devDependency of gateway (inlined, #1027)", () => {
    // The on-disk source manifest — NOT the copy embedded in the bundle text.
    // gateway inlines core into BOTH bundles (script/bundle.ts), so the
    // published package never imports @loreai/core at runtime. It must NOT be a
    // runtime dependency (that dragged core's ~480 MB ML tree into raw-npm
    // gateway installs — #1024/#1026); it stays a devDependency because the
    // bundle build needs core's source. Contrast opencode/pi below, which
    // import core at runtime and therefore MUST keep it as a runtime dep.
    expect(pkgJson.dependencies?.["@loreai/core"]).toBeUndefined();
    expect(pkgJson.devDependencies?.["@loreai/core"]).toBe("workspace:*");
  });

  // Internal packages each consumer imports at RUNTIME. #998 happened in the
  // plugin's dependency chain (@loreai/opencode → @loreai/gateway → external
  // @loreai/core), so presence — not just spec correctness — is asserted for
  // every link. devDependencies are never installed for a transitively-
  // consumed published package, which is exactly how #998 manifested.
  //
  // gateway is intentionally ABSENT here: it inlines core (build-only devDep,
  // #1027), so it has no internal @loreai/* runtime dependency to guard.
  const requiredInternalDeps: Record<string, string[]> = {
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
    // Every internal @loreai/* reference — runtime OR build-only — must be
    // `workspace:*`, which `pnpm pack` rewrites to the exact release version so
    // all packages stay unified per release. Checks devDependencies too so
    // gateway's build-only core reference (#1027) is covered. (The old
    // "two copies → two _originalFetch → fetch loop" rationale no longer
    // applies: the handle is a Symbol.for process-global shared by all copies.)
    for (const name of ["gateway", "opencode", "pi"]) {
      const manifest = JSON.parse(
        readFileSync(join(packageDir, "..", name, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
      };
      for (const [dep, spec] of Object.entries(allDeps)) {
        if (dep.startsWith("@loreai/")) {
          expect(spec, `${manifest.name} → ${dep}`).toBe("workspace:*");
        }
      }
    }
  });
});
