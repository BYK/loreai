/**
 * Token estimation using `coder/ai-tokenizer` — real BPE encodings instead of
 * the legacy `Math.ceil(text.length / 3)` heuristic.
 *
 * Use model-specific counts when a matching encoding is available. Modern
 * Claude counts are approximated with the bundled Claude BPE and a family
 * correction measured against Anthropic's count_tokens API.
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
import { AsyncLocalStorage } from "node:async_hooks";
import { Tokenizer } from "ai-tokenizer";
import * as cl100k_base_encoding from "ai-tokenizer/encoding/cl100k_base";
import * as o200k_base_encoding from "ai-tokenizer/encoding/o200k_base";
import * as claude_encoding from "ai-tokenizer/encoding/claude";

type BundledEncoding = "cl100k_base" | "o200k_base" | "claude";
export type EncodingName =
  | BundledEncoding
  | "claude-v3-estimate"
  | "claude-v4.7-estimate";

interface TokenCountCache {
  countTokens(
    text: string,
    encoding: EncodingName,
    compute: () => number,
  ): number;
}

const countCache = new AsyncLocalStorage<TokenCountCache>();

/** Request-local counting only: never installs a process-wide content cache. */
export function withTokenCountCache<T>(cache: TokenCountCache, fn: () => T): T {
  return countCache.run(cache, fn);
}

// Durable derived counts must miss after an encoding/tokenizer-policy change.
// The contract test checks this against the installed tokenizer version.
export const TOKEN_ESTIMATE_CACHE_VERSION =
  "ai-tokenizer@1.0.6:cl100k_base:ordinary-v2";

const cache = new Map<BundledEncoding, Tokenizer>();
cache.set("cl100k_base", new Tokenizer(cl100k_base_encoding));

function getTokenizer(name: BundledEncoding): Tokenizer {
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

/** Select the counting policy from the model name, including routed aliases. */
export function encodingForModel(opts: {
  providerID?: string;
  modelID?: string;
}): EncodingName {
  const modelID = opts.modelID ?? "";
  if (
    /\bclaude-(?:(?:opus|sonnet|haiku|fable|mythos)-)?(?:4[.-][7-9]|[5-9])\b/i.test(
      modelID,
    )
  )
    return "claude-v4.7-estimate";
  if (/\bclaude-(?:(?:opus|sonnet|haiku)-)?[34]\b/i.test(modelID))
    return "claude-v3-estimate";
  if (opts.providerID === "anthropic" || /\bclaude-/i.test(modelID))
    return "claude";

  // GPT-6 uses o200k as a proxy. Published API measurements matched GPT-5
  // across 31 texts, and the upstream tiktoken map has no GPT-6 entry.
  if (
    /\b(?:gpt-(?:4o|4[.]1|4[.]5|[56]|oss)|o1|o3|o4-mini|codex-mini)\b/i.test(
      modelID,
    )
  )
    return "o200k_base";
  return "cl100k_base";
}

/**
 * Estimate token count for a text string using a real BPE encoding.
 *
 * Input is ordinary content, even when it quotes a tokenizer control marker.
 * Tokenizer failures fall back to Lore's legacy characters/3 heuristic.
 * Never expose an exception that may contain the input text.
 */
export function estimateTokens(
  text: string,
  opts: { providerID?: string; modelID?: string; encoding?: EncodingName } = {},
): number {
  if (!text) return 0;
  try {
    const encoding = opts.encoding ?? encodingForModel(opts);
    const compute = () => {
      // Fit the ratio of provider content tokens to bundled BPE counts on
      // short samples (>=10 provider tokens) from coder/ai-tokenizer's
      // Claude count_tokens fixture at 6dec619. Keep the API framing separate.
      if (encoding === "claude-v3-estimate")
        return Math.round(getTokenizer("claude").count(text) * 1.09);
      if (encoding === "claude-v4.7-estimate")
        return Math.round(getTokenizer("claude").count(text) * 1.34);
      return getTokenizer(encoding).count(text);
    };
    const active = countCache.getStore();
    return active ? active.countTokens(text, encoding, compute) : compute();
  } catch {
    return Math.ceil(text.length / 3);
  }
}

/**
 * Test hook: reset the encoding cache. Used by tests that switch providers
 * mid-run to ensure lazy construction runs in the expected order.
 */
export function _resetTokenizeCacheForTest(): void {
  cache.clear();
  cache.set("cl100k_base", new Tokenizer(cl100k_base_encoding));
}
