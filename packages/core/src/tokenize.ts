/**
 * Token estimation using `coder/ai-tokenizer` — real BPE encodings instead of
 * the legacy `Math.ceil(text.length / 3)` heuristic.
 *
 * Encoding selection is per-provider so the count tracks what the upstream
 * model would actually charge (and what its context window actually fits):
 *   - `anthropic` → `claude` encoding
 *   - `gpt-4o`/`gpt-5*`/`gpt-5.*` → `o200k_base`
 *   - everything else → `cl100k_base` (covers GPT-4/3.5, Claude-on-OpenAI
 *     routers, Copilot, OpenRouter, Gemini, etc.)
 *
 * Encoding data (~13 MB uncompressed, ~4 MB gzipped) is inlined into the CJS
 * bundle / SEA binary by esbuild — there's no runtime dependency on
 * `ai-tokenizer` for end users installing `@loreai/gateway`. Source dev pulls
 * it from `devDependencies`.
 *
 * `Tokenizer` instances are constructed lazily so the cost (~14 µs per
 * encoding init) is paid only when that encoding is actually needed. The
 * `cl100k_base` Tokenizer is constructed eagerly as the common-case default.
 * Encoding *data* (BPE rank tables) is imported eagerly at module load — that
 * memory is unavoidable in a CJS bundle.
 */
import { Tokenizer } from "ai-tokenizer";
import * as cl100k_base_encoding from "ai-tokenizer/encoding/cl100k_base";
import * as o200k_base_encoding from "ai-tokenizer/encoding/o200k_base";
import * as claude_encoding from "ai-tokenizer/encoding/claude";

export type EncodingName = "cl100k_base" | "o200k_base" | "claude";

const cache = new Map<EncodingName, Tokenizer>();
cache.set("cl100k_base", new Tokenizer(cl100k_base_encoding));

function getTokenizer(name: EncodingName): Tokenizer {
  const existing = cache.get(name);
  if (existing) return existing;
  const enc =
    name === "o200k_base"
      ? o200k_base_encoding
      : name === "claude"
        ? claude_encoding
        : cl100k_base_encoding;
  const tk = new Tokenizer(enc);
  cache.set(name, tk);
  return tk;
}

/**
 * Pick the encoding for a given provider/model. Falls back to `cl100k_base`
 * when nothing matches (covers OpenAI-compatible routers, Copilot, etc.).
 */
export function encodingForModel(opts: {
  providerID?: string;
  modelID?: string;
}): EncodingName {
  if (opts.providerID === "anthropic") return "claude";
  const modelID = opts.modelID ?? "";
  if (/\b(gpt-4o|gpt-5|gpt-5\.\d)\b/i.test(modelID)) return "o200k_base";
  return "cl100k_base";
}

/**
 * Estimate token count for a text string using a real BPE encoding.
 *
 * Sync. Empty input returns 0 (Tokenizer.count throws on empty in some
 * encodings — guard at the boundary to keep call sites simple).
 */
export function estimateTokens(
  text: string,
  opts: { providerID?: string; modelID?: string } = {},
): number {
  if (!text) return 0;
  return getTokenizer(encodingForModel(opts)).count(text);
}

/**
 * Test hook: reset the encoding cache. Used by tests that switch providers
 * mid-run to ensure lazy construction runs in the expected order.
 */
export function _resetTokenizeCacheForTest(): void {
  cache.clear();
  cache.set("cl100k_base", new Tokenizer(cl100k_base_encoding));
}
