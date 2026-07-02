/**
 * Regression battery for the SHARED original-fetch handle (#1027, #1107).
 *
 * The fetch interceptor stores the pre-install `globalThis.fetch` in a
 * process-global keyed by `Symbol.for(...)`. It backs the cross-copy
 * double-install guard so that EVERY copy of @loreai/core in the process
 * agrees a single interceptor is installed — even when core is
 * bundled/instantiated more than once (e.g. the OpenCode plugin's copy plus a
 * copy inlined into the in-process gateway bundle).
 *
 * Without a shared handle, each module copy keeps a private module-scoped slot:
 * one copy installs the interceptor (patching `globalThis.fetch`) while a
 * second copy's guard still sees `null` and installs AGAIN, stacking
 * interceptors (copy B captures copy A's interceptor as its "original") — an
 * infinite request loop (gateway → interceptor → gateway → …). These tests pin
 * that invariant by observing the shared slot directly (the internal handle is
 * not exported — see #1107).
 *
 * Tests 3 and 4 load two *independent* module instances (via
 * `vi.resetModules()` + dynamic import) to simulate the two-copies-in-one-
 * process scenario. They FAIL against a module-scoped slot and PASS with the
 * shared `Symbol.for` global.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { installFetchInterceptor } from "../src/fetch-interceptor";

const ORIGINAL_FETCH_KEY = Symbol.for("lore.fetchInterceptor.originalFetch");
const GATEWAY = "http://127.0.0.1:3207";
const config = { gatewayBase: GATEWAY, getHeaders: () => ({}) };

/** Read the process-global slot the interceptor stores the real fetch in. */
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
      // The shared handle holds the REAL fetch...
      expect(slot()).toBe(trueOriginal);
      // ...and globalThis.fetch has been patched to the interceptor.
      expect(globalThis.fetch).not.toBe(trueOriginal);
    } finally {
      cleanup();
    }
    // Cleanup restores the live fetch and releases the shared handle.
    expect(globalThis.fetch).toBe(trueOriginal);
    expect(slot() ?? null).toBeNull();
  });

  test("the shared slot holds the real fetch, never the installed interceptor", () => {
    const cleanup = installFetchInterceptor(config);
    try {
      // The crux: the stored handle must be the true original, NOT
      // globalThis.fetch (the interceptor). A self-referential handle is what
      // loops.
      expect(slot()).toBe(trueOriginal);
      expect(slot()).not.toBe(globalThis.fetch);
    } finally {
      cleanup();
    }
  });

  test("a second module copy shares the slot and does not re-install (cross-copy loop guard)", async () => {
    // Two independently-evaluated module instances = two copies of core in one
    // process. They share globalThis but have distinct module scopes.
    vi.resetModules();
    const modA = await import("../src/fetch-interceptor");
    vi.resetModules();
    const modB = await import("../src/fetch-interceptor");
    // Sanity: genuinely distinct module instances.
    expect(modB.installFetchInterceptor).not.toBe(modA.installFetchInterceptor);

    const cleanupA = modA.installFetchInterceptor(config);
    try {
      const interceptorA = globalThis.fetch;
      // Copy A patched globalThis.fetch and set the shared slot to the real fetch.
      expect(interceptorA).not.toBe(trueOriginal);
      expect(slot()).toBe(trueOriginal);

      // Copy B — a SEPARATE module scope with its own (empty) private state —
      // sees the shared slot as already set and MUST no-op: it must not
      // re-patch globalThis.fetch (which would capture A's interceptor as B's
      // "original" and stack a second layer → infinite loop). Under a
      // module-scoped slot, B's guard sees null and re-patches here.
      modB.installFetchInterceptor(config);
      expect(globalThis.fetch).toBe(interceptorA); // unchanged by B
      expect(slot()).toBe(trueOriginal); // shared slot untouched
    } finally {
      cleanupA();
    }
  });

  test("a second copy's cleanup is a no-op while another copy owns the interceptor", async () => {
    vi.resetModules();
    const modA = await import("../src/fetch-interceptor");
    vi.resetModules();
    const modB = await import("../src/fetch-interceptor");

    const cleanupA = modA.installFetchInterceptor(config);
    try {
      const interceptorA = globalThis.fetch;
      expect(interceptorA).not.toBe(trueOriginal);

      // B's install no-ops (slot already set) and returns a no-op cleanup.
      const cleanupB = modB.installFetchInterceptor(config);
      // Calling it must NOT tear down A's interceptor nor release the shared
      // handle A still owns.
      cleanupB();
      expect(globalThis.fetch).toBe(interceptorA);
      expect(slot()).toBe(trueOriginal);
    } finally {
      cleanupA();
    }
    // Only A's cleanup restores; the process is back to the live fetch.
    expect(globalThis.fetch).toBe(trueOriginal);
    expect(slot() ?? null).toBeNull();
  });
});
