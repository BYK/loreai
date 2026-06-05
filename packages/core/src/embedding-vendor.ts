/**
 * Vendored model registration for the standalone Lore binary.
 *
 * The fossilize-built `lore` binary bundles `@huggingface/transformers`
 * (which includes onnxruntime-web) into the executable. The model
 * weights and tokenizer files (nomic-embed-text-v1.5, INT8 quantized)
 * are embedded as SEA assets and extracted to a cache dir on first run.
 *
 * The binary's sea-entry.ts sets `globalThis.__LORE_VENDOR_MODEL__` to
 * the extraction path. This module exposes that registration to the
 * `LocalProvider` so it can configure the transformers.js `env` to
 * load from the local path instead of downloading from HuggingFace Hub.
 *
 * In npm-mode usage from `@loreai/opencode` / `@loreai/pi` the global
 * is unset and `vendorModelInfo()` returns `null`, so transformers.js
 * downloads the model from HF Hub on first use and caches it locally.
 */

// ---------------------------------------------------------------------------
// Vendor registration (set by the binary wrapper, read here)
// ---------------------------------------------------------------------------

/** What the binary wrapper writes to globalThis after extracting model files. */
export interface VendorRegistration {
  /** Absolute path to the dir containing the model files in HF layout
   *  (config.json, tokenizer.json, onnx/model_quantized.onnx, …).
   *  Passed to transformers.js as `env.localModelPath`. */
  localModelPath: string;
  /** Target identifier the binary was built for, e.g. "linux-x64".
   *  Diagnostic only — the runtime doesn't branch on it. */
  target: string;
  /** Lore CLI version that produced the binary. Diagnostic only. */
  version: string;
}

const REGISTRATION_KEY = "__LORE_VENDOR_MODEL__";

/** Read the vendor registration written by the binary wrapper, if any. */
function getRegistration(): VendorRegistration | null {
  const g = globalThis as unknown as Record<
    string,
    VendorRegistration | undefined
  >;
  return g[REGISTRATION_KEY] ?? null;
}

/** Test-only: programmatically set/clear the registration to exercise
 *  both binary-mode and npm-mode code paths without spinning up a real
 *  compiled binary. */
export function _setVendorRegistration(reg: VendorRegistration | null): void {
  const g = globalThis as unknown as Record<
    string,
    VendorRegistration | undefined
  >;
  if (reg) g[REGISTRATION_KEY] = reg;
  else delete g[REGISTRATION_KEY];
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/** Subset of the registration the LocalProvider needs. */
export interface VendorModelInfo {
  /** Absolute path to the dir containing the model in HF layout.
   *  Set as `env.localModelPath` in the worker thread. */
  localModelPath: string;
}

/**
 * Environment override for the local model directory.
 *
 * When `LORE_LOCAL_MODEL_PATH` points at an existing directory, the local
 * provider loads the model from there with `allowRemoteModels=false` — no
 * HuggingFace Hub download. This is used for:
 *  - air-gapped / offline installs that pre-stage the model, and
 *  - CI, which vendors the model once (cached) and points tests at it so the
 *    test run never depends on HF Hub availability (avoids transient 429s).
 *
 * The value is the cache ROOT, matching the binary wrapper's `localModelPath`:
 * transformers.js resolves the model at `<root>/<modelId>/<file>` (e.g.
 * `<root>/nomic-ai/nomic-embed-text-v1.5/onnx/model_quantized.onnx`). This is
 * the `.vendor-build/.model-cache` dir produced by `vendor-embeddings.ts`.
 *
 * Takes precedence over the binary-wrapper registration so it can also be used
 * to override a vendored binary's extracted path in tests.
 */
export const LOCAL_MODEL_PATH_ENV = "LORE_LOCAL_MODEL_PATH";

function envModelPath(): string | null {
  const p = process.env[LOCAL_MODEL_PATH_ENV];
  if (!p) return null;
  // Best-effort existence check — a missing or non-directory path falls through
  // to HF download rather than failing init (so a stale env var never bricks
  // embeddings). We specifically check for a directory because transformers.js
  // resolves model files as <localModelPath>/<modelId>/<file>.
  try {
    // Lazy require so this module stays usable in non-Node contexts.
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const stat = statSync(p, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return null;
  } catch {
    // If we can't stat (unusual), trust the path and let the worker report.
  }
  return p;
}

/**
 * Resolve the vendored model path for transformers.js local loading.
 * Resolution order:
 *   1. `LORE_LOCAL_MODEL_PATH` env override (offline installs / CI), then
 *   2. binary-wrapper registration (`globalThis.__LORE_VENDOR_MODEL__`).
 * Returns `null` when neither is present (npm-mode), so the caller falls
 * through to transformers.js's default HF Hub download + cache.
 */
export function vendorModelInfo(): VendorModelInfo | null {
  const envPath = envModelPath();
  if (envPath) return { localModelPath: envPath };

  const reg = getRegistration();
  if (!reg) return null;
  return {
    localModelPath: reg.localModelPath,
  };
}

/** True iff this process is running inside a vendored Lore binary. */
export function isVendoredBinary(): boolean {
  return getRegistration() !== null;
}

/** The full registration, for diagnostics (`lore --print-vendor-info`). */
export function vendorRegistration(): VendorRegistration | null {
  return getRegistration();
}
