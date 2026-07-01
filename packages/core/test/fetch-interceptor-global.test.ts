/**
 * Regression battery for the SHARED original-fetch handle (#1027).
 *
 * The fetch interceptor stores the pre-install `globalThis.fetch` in a
 * process-global keyed by `Symbol.for(...)` so that EVERY copy of
 * @loreai/core in the process agrees on the same original fetch — even when
 * core is bundled/instantiated more than once (e.g. the OpenCode plugin's
 * copy plus a copy inlined into the in-process gateway bundle).
 *
 * Without a shared handle, each module copy keeps a private module-scoped
 * `_originalFetch`: one copy installs the interceptor (patching
 * `globalThis.fetch`) while a second copy's `getOriginalFetch()` still reads
 * `null` and falls back to `globalThis.fetch` — which IS the interceptor —
 * producing an infinite request loop. These tests pin that invariant.
 *
 * Tests 3 and 4 load two *independent* module instances (via
 * `vi.resetModules()` + dynamic import) to simulate the two-copies-in-one-
 * process scenario. They FAIL against a module-scoped `_originalFetch` and
 * PASS with the shared `Symbol.for` global.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installFetchInterceptor,
  getOriginalFetch,
} from "../src/fetch-interceptor";

const ORIGINAL_FETCH_KEY = Symbol.for("lore.fetchInterceptor.originalFetch");
const GATEWAY = "http://127.0.0.1:3207";
const config = { gatewayBase: GATEWAY, getHeaders: () => ({}) };

function slot(): unknown {
  return (globalThis as Record<symbol, unknown>)[ORIGINAL_FETCH_KEY];
}
function clearSlot(): void {
  delete (globalThis as Record<symbol, unknown>)[ORIGINAL_FETCH_KEY];
}

describe("fetch-interceptor — shared original-fetch global (#1027)", () => {
  let trueOriginal: typeof globalThis.fetch;

  beforeEach(() => {
    // Snapshot the live fetch (restored in afterEach) and start from a clean
    // process-global slot so each test's install proceeds deterministically.
    trueOriginal = globalThis.fetch;
    clearSlot();
  });

  afterEach(() => {
    globalThis.fetch = trueOriginal;
    clearSlot();
  });

  test("install captures the pre-install fetch into the shared Symbol.for slot", () => {
    const cleanup = installFetchInterceptor(config);
    try {
      // The shared handle holds the REAL fetch, not the interceptor.
      expect(slot()).toBe(trueOriginal);
      // globalThis.fetch has been patched to the interceptor.
      expect(globalThis.fetch).not.toBe(trueOriginal);
      // getOriginalFetch reads the shared handle.
      expect(getOriginalFetch()).toBe(trueOriginal);
    } finally {
      cleanup();
    }
    // Cleanup restores the live fetch and releases the shared handle.
    expect(globalThis.fetch).toBe(trueOriginal);
    expect(getOriginalFetch()).toBe(globalThis.fetch);
  });

  test("getOriginalFetch returns the real fetch, never the installed interceptor", () => {
    const cleanup = installFetchInterceptor(config);
    try {
      const original = getOriginalFetch();
      expect(original).toBe(trueOriginal);
      // The crux: it must NOT resolve to globalThis.fetch (the interceptor),
      // which would be self-referential and loop.
      expect(original).not.toBe(globalThis.fetch);
    } finally {
      cleanup();
    }
  });

  test("a second module copy resolves the same original fetch (cross-copy loop guard)", async () => {
    // Two independently-evaluated module instances = two copies of core in
    // one process. They share globalThis but have distinct module scopes.
    vi.resetModules();
    const modA = await import("../src/fetch-interceptor");
    vi.resetModules();
    const modB = await import("../src/fetch-interceptor");
    // Sanity: genuinely distinct module instances.
    expect(modB.installFetchInterceptor).not.toBe(modA.installFetchInterceptor);

    const cleanup = modA.installFetchInterceptor(config);
    try {
      // Copy A patched globalThis.fetch to its interceptor.
      expect(globalThis.fetch).not.toBe(trueOriginal);
      // Copy B — separate module scope, empty private state — must still see
      // the TRUE original via the shared global, not the interceptor. Under a
      // module-scoped _originalFetch this returned globalThis.fetch (the
      // interceptor) → infinite fetch loop.
      expect(modB.getOriginalFetch()).toBe(trueOriginal);
      expect(modB.getOriginalFetch()).not.toBe(globalThis.fetch);
    } finally {
      cleanup();
    }
  });

  test("a second copy's install is a no-op while another copy owns the interceptor", async () => {
    vi.resetModules();
    const modA = await import("../src/fetch-interceptor");
    vi.resetModules();
    const modB = await import("../src/fetch-interceptor");

    const cleanupA = modA.installFetchInterceptor(config);
    try {
      const interceptorA = globalThis.fetch;
      expect(interceptorA).not.toBe(trueOriginal);

      // Copy B must detect the shared slot is already set and NOT re-patch
      // globalThis.fetch — re-patching would capture A's interceptor as B's
      // "original", stacking a second interception layer.
      const cleanupB = modB.installFetchInterceptor(config);
      expect(globalThis.fetch).toBe(interceptorA); // unchanged by B
      expect(modB.getOriginalFetch()).toBe(trueOriginal);

      // B's cleanup is a no-op: it must not tear down A's interceptor nor
      // release the shared handle A still owns.
      cleanupB();
      expect(globalThis.fetch).toBe(interceptorA);
      expect(getOriginalFetch()).toBe(trueOriginal);
    } finally {
      cleanupA();
    }
    // Only A's cleanup restores; the process is back to the live fetch.
    expect(getOriginalFetch()).toBe(globalThis.fetch);
  });
});
