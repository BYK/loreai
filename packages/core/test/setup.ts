import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "bun:test";
import { close } from "../src/db";

// Create an isolated temporary database for the entire test run.
// This prevents test fixtures from leaking into the live lore DB
// at ~/.local/share/lore/lore.db.
const tmp = mkdtempSync(join(tmpdir(), "lore-test-"));
process.env.LORE_DB_PATH = join(tmp, "test.db");

// ---------------------------------------------------------------------------
// Block live network to models.dev during tests.
//
// `fetchModelData()` (gateway/src/worker-model.ts) hits
// https://models.dev/api.json to pull pricing/limits, and the gateway
// pre-warms it on startup (pipeline.ts). Any test that starts a real gateway
// — or any test running while another file's pipeline pre-warm fires — would
// otherwise make a live HTTP call. That made the suite depend on a 3rd-party
// API being up: it flaked when models.dev returned 500 / timed out, and it
// polluted worker-model.test.ts's fetch-mock assertions across files.
//
// We install a baseline `globalThis.fetch` that intercepts ONLY the models.dev
// endpoint (returning canned, realistic data) and delegates everything else to
// the real implementation. Tests that override `globalThis.fetch` still work:
// they replace the global, and when they restore the captured `originalFetch`
// in afterEach they restore THIS guard, so post-test async pre-warms stay
// offline too. Mirrors the SENTRY_ENABLED=0 "no background fetch leaks into
// tests" precedent in bunfig.toml.
const MODELS_DEV_API = "https://models.dev/api.json";
const CANNED_MODELS_DEV = {
  anthropic: {
    models: {
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        cost: { input: 5, output: 25, cache_read: 0.5 },
        limit: { context: 1_000_000, output: 128_000 },
      },
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        cost: { input: 3, output: 15, cache_read: 0.3 },
        limit: { context: 1_000_000, output: 64_000 },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        cost: { input: 1, output: 5, cache_read: 0.1 },
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
  openai: {
    models: {
      "gpt-5.4-mini": {
        id: "gpt-5.4-mini",
        cost: { input: 0.75, output: 4.5, cache_read: 0.19 },
        limit: { context: 400_000, output: 100_000 },
      },
    },
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url === MODELS_DEV_API) {
    return Promise.resolve(
      new Response(JSON.stringify(CANNED_MODELS_DEV), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;

afterAll(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});
