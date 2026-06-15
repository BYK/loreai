/**
 * Download and cache the embedding model files for binary builds.
 *
 * @huggingface/transformers bundles its own ONNX Runtime, so we don't need
 * per-target staging trees with platform-specific native bindings. We just
 * need the model files (config, tokenizer, ONNX weights) in HuggingFace
 * repo layout.
 *
 * Outputs (side effects only — no stdout product):
 *   - `<repo>/.vendor-build/.model-cache/<MODEL_DIR_NAME>/` — model files
 *     in HF layout, downloaded once from HuggingFace Hub. Platform-independent
 *     (pure ONNX + JSON), so build.ts embeds the same files into every
 *     per-target binary.
 *
 * Usage:
 *   tsx packages/gateway/script/vendor-embeddings.ts
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_DIR_NAME, MODEL_ID, MODEL_FILES } from "./vendor-paths";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));

console.log(`→ vendor-embeddings: model=${MODEL_ID}`);

// ---------------------------------------------------------------------------
// Retry logic for transient HuggingFace Hub errors (429, 5xx, network)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
/** Transient HTTP codes worth retrying. 529 = Cloudflare "Site Overloaded" (HF uses CF). */
const TRANSIENT_CODES = new Set([429, 500, 502, 503, 529]);
const RETRY_AFTER_CAP_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let r: Response;
    try {
      r = await fetch(url);
    } catch (err) {
      // Network-level failure (DNS, TLS, connection reset)
      if (attempt === MAX_RETRIES) {
        console.error(
          `✗ network error: ${url} → ${err}` +
            (attempt > 0 ? ` (after ${attempt + 1} attempts)` : ""),
        );
        process.exit(1);
      }
      const delayMs = Math.min(1000 * 2 ** attempt, 30_000);
      console.warn(
        `  ⚠ network error — retrying in ${(delayMs / 1000).toFixed(1)}s ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delayMs);
      continue;
    }

    if (r.ok) return r;

    if (!TRANSIENT_CODES.has(r.status) || attempt === MAX_RETRIES) {
      console.error(
        `✗ download failed: ${url} → HTTP ${r.status} ${r.statusText}` +
          (attempt > 0 ? ` (after ${attempt + 1} attempts)` : ""),
      );
      process.exit(1);
    }

    // Determine backoff: honor Retry-After when present, else exponential
    let delayMs: number;
    const retryAfter = r.headers.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      delayMs = Number.isFinite(secs)
        ? Math.min(secs * 1000, RETRY_AFTER_CAP_MS)
        : Math.min(1000 * 2 ** attempt, 30_000);
    } else {
      delayMs = Math.min(1000 * 2 ** attempt, 30_000);
    }

    console.warn(
      `  ⚠ HTTP ${r.status} — retrying in ${(delayMs / 1000).toFixed(1)}s ` +
        `(attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    // Drain the response body to release the connection
    await r.arrayBuffer().catch(() => {});
    await sleep(delayMs);
  }

  // Unreachable — the loop either returns or exits, but TypeScript needs this
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared model cache (nomic-embed-text-v1.5)
// ---------------------------------------------------------------------------

await ensureSharedModelCache();

/**
 * Ensure `<repo>/.vendor-build/.model-cache/<MODEL_DIR_NAME>/` is populated
 * with all files transformers.js needs to load the model locally.
 *
 * We download from `nomic-ai/nomic-embed-text-v1.5` on HuggingFace Hub.
 * The INT8 quantized ONNX model is ~137 MB; config + tokenizer files are
 * a few hundred KB total.
 *
 * Layout matches the HF repo structure that transformers.js expects:
 *   <model_dir>/config.json
 *   <model_dir>/tokenizer.json
 *   <model_dir>/tokenizer_config.json
 *   <model_dir>/special_tokens_map.json
 *   <model_dir>/onnx/model_quantized.onnx
 */
async function ensureSharedModelCache(): Promise<string> {
  const sharedCache = join(repoRoot, ".vendor-build", ".model-cache");
  const modelDir = join(sharedCache, MODEL_DIR_NAME);

  const allPresent = MODEL_FILES.every((f) => existsSync(join(modelDir, f)));
  if (allPresent) {
    console.log(`✓ shared model cache hit at ${relative(repoRoot, modelDir)}/`);
    return sharedCache;
  }

  console.log(`→ downloading ${MODEL_ID} (INT8 quantized, ~137 MB)`);
  // Create dirs including onnx/ subdir
  mkdirSync(join(modelDir, "onnx"), { recursive: true });

  const baseUrl = `https://huggingface.co/${MODEL_ID}/resolve/main`;

  for (const filePath of MODEL_FILES) {
    const url = `${baseUrl}/${filePath}`;
    const dest = join(modelDir, filePath);

    console.log(`  ↓ ${filePath}`);
    const r = await fetchWithRetry(url);
    writeFileSync(dest, new Uint8Array(await r.arrayBuffer()));
  }

  const sizeMb = dirSizeBytes(modelDir) / 1024 / 1024;
  console.log(
    `✓ model cached at ${relative(repoRoot, modelDir)}/ (${sizeMb.toFixed(1)} MB)`,
  );
  return sharedCache;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(p) : statSync(p).size;
  }
  return total;
}
