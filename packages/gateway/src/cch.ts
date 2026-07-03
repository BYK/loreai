/**
 * Claude Code billing header (`cch`) computation for worker requests.
 *
 * Claude Code OAuth bearer tokens require an `x-anthropic-billing-header`
 * as the first system prompt block. The `cch` field is an xxHash64 of the
 * entire serialized request body, masked to 20 bits (5 hex chars).
 *
 * The standalone Claude binary computes this in custom Zig code injected
 * into nativeFetch. We replicate the algorithm for our worker calls which
 * build requests from scratch and can't piggyback on the binary's signing.
 *
 * Algorithm (from https://a10k.co/b/reverse-engineering-claude-code-cch.html):
 *   1. Build body JSON with `cch=00000` placeholder
 *   2. cch = xxHash64(body_bytes, seed) & 0xFFFFF → 5-char hex
 *   3. Replace `cch=00000` with computed value
 *
 * The seed is a 64-bit constant baked into Claude Code's custom Bun binary.
 * It changes between releases and is not stored as a raw byte pattern —
 * the Zig compiler inlines it into the instruction stream or computes it
 * at comptime, leaving no searchable trace in the binary.
 *
 * We maintain a version→seed mapping. Workers pin their billing header to
 * a version with a known seed so the cch hash is valid. Conversation
 * requests are forwarded as-is with the client's own signed cch.
 *
 * Per-session state: each conversation turn records whether the session
 * uses bearer-token auth (Claude Code OAuth) so workers know to inject
 * the billing header. Keyed by sessionID to prevent cross-session
 * contamination. Mirrors the per-session `sessionAuth` in `auth.ts`.
 */

import { createHash, randomUUID } from "node:crypto";
import { log } from "@loreai/core";
import * as Sentry from "@sentry/bun";
import { xxHash64 } from "./xxhash.ts";

/**
 * Claude Code (>= 2.1.181) only emits the `cch` billing field when it believes
 * it is talking to the first-party API — it checks that ANTHROPIC_BASE_URL's
 * host is exactly `api.anthropic.com` (or unset), otherwise it suppresses `cch`
 * entirely. Setting this env var to a truthy value forces the first-party
 * assumption. The Lore gateway is a transparent proxy to the first-party API,
 * so any process it points at the gateway (Claude Code launched via `lore run`
 * or configured via `lore setup`, and the seed extractor's capture server)
 * must set this so `cch` keeps flowing. See quality/CCH.md.
 */
export const CLAUDE_CODE_FIRST_PARTY_ENV =
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL";

// ---------------------------------------------------------------------------
// Version→seed mapping
// ---------------------------------------------------------------------------

/**
 * Known version→seed pairs. Seeds are extracted from the ARM64 macOS Claude
 * Code binary using the oracle approach:
 *   1. Collect (body_with_placeholder, signed_cch) pairs from live traffic
 *   2. Download `@anthropic-ai/claude-code-darwin-arm64@VERSION` from npm
 *   3. Test every 8-byte aligned offset in the binary as candidate seed
 *   4. Two oracle pairs eliminate all false positives (~8s scan time)
 *   5. Validate the candidate seed against all collected pairs
 *
 * See `scripts/extract-cch-seed.ts` for the automated extraction tool.
 */
// Named seed constants. Claude Code reuses the same xxHash64 seed across many
// consecutive versions and only rotates it occasionally, so versions are mapped
// to a shared named constant rather than repeating the same literal. When the
// extraction tool finds a seed that matches an existing constant it references
// that constant; a genuinely new seed gets its own `SEED_<version>` constant.
const SEED_2_1_37 = 0x6e52736ac806831en;
const SEED_2_1_138 = 0x4d659218e32a3268n;

const VERSION_SEEDS: Record<string, bigint> = {
  "2.1.37": SEED_2_1_37,
  "2.1.138": SEED_2_1_138,
  "2.1.139": SEED_2_1_138,
  "2.1.140": SEED_2_1_138,
  "2.1.141": SEED_2_1_138,
  "2.1.142": SEED_2_1_138,
  "2.1.143": SEED_2_1_138,
  "2.1.144": SEED_2_1_138,
  "2.1.145": SEED_2_1_138,
  "2.1.146": SEED_2_1_138,
  "2.1.147": SEED_2_1_138,
  "2.1.148": SEED_2_1_138,
  "2.1.149": SEED_2_1_138,
  "2.1.150": SEED_2_1_138,
  "2.1.152": SEED_2_1_138,
  "2.1.153": SEED_2_1_138,
  "2.1.154": SEED_2_1_138,
  "2.1.156": SEED_2_1_138,
  "2.1.157": SEED_2_1_138,
  "2.1.158": SEED_2_1_138,
  "2.1.159": SEED_2_1_138,
  "2.1.160": SEED_2_1_138,
  "2.1.161": SEED_2_1_138,
  "2.1.162": SEED_2_1_138,
  "2.1.163": SEED_2_1_138,
  "2.1.165": SEED_2_1_138,
  "2.1.166": SEED_2_1_138,
  "2.1.167": SEED_2_1_138,
  "2.1.168": SEED_2_1_138,
  "2.1.169": SEED_2_1_138,
  "2.1.170": SEED_2_1_138,
  // 2.1.172+ : seed UNCHANGED, but the cch hash preimage changed — the binary
  // strips the `model` value and the `max_tokens` field before hashing. See
  // `cchPreimage()` and quality/CCH.md. signBody() applies that transform.
  "2.1.172": SEED_2_1_138,
  "2.1.173": SEED_2_1_138,
  "2.1.175": SEED_2_1_138,
  "2.1.176": SEED_2_1_138,
  "2.1.177": SEED_2_1_138,
  "2.1.178": SEED_2_1_138,
  "2.1.179": SEED_2_1_138,
  "2.1.181": SEED_2_1_138,
  "2.1.183": SEED_2_1_138,
  "2.1.182": SEED_2_1_138,
  "2.1.185": SEED_2_1_138,
  "2.1.186": SEED_2_1_138,
  "2.1.187": SEED_2_1_138,
  "2.1.190": SEED_2_1_138,
  "2.1.191": SEED_2_1_138,
  "2.1.193": SEED_2_1_138,
  "2.1.195": SEED_2_1_138,
  "2.1.196": SEED_2_1_138,
  "2.1.197": SEED_2_1_138,
  "2.1.198": SEED_2_1_138,
  "2.1.199": SEED_2_1_138,
  // Future versions: extract and add entries here.
  // Use `node scripts/extract-cch-seed.ts --version X.Y.Z` to extract.
};

/** Version we pin worker billing headers to (must have a known seed). */
const WORKER_VERSION = "2.1.199";
const WORKER_SEED = VERSION_SEEDS[WORKER_VERSION];
if (WORKER_SEED === undefined) {
  throw new Error(`Missing CCH seed for worker version ${WORKER_VERSION}`);
}

/**
 * Salt for the cc_version suffix computation. Embedded in Claude Code's
 * JavaScript source (extractable from the Bun binary). This is per-version
 * but easily found by searching the extracted JS for the suffix function.
 */
const WORKER_SALT = "59cf53e54c78";

const CCH_PLACEHOLDER = "cch=00000";

/**
 * The full billing-header sentinel as it appears in a serialized JSON body:
 *
 *   x-anthropic-billing-header: cc_version=<semver>.<suffix>; cc_entrypoint=<x>; cch=<value>;
 *
 * We anchor every cch / cc_version rewrite to this whole shape rather than to
 * a bare `cc_entrypoint=…;` or `cch=…;` fragment. A token in system / LTM /
 * message content can only be mistaken for the header if it reproduces the
 * ENTIRE `x-anthropic-billing-header: …` sentinel verbatim — a far narrower
 * surface than the bare `cch=`/`cc_entrypoint=` fragment the original fix
 * caught, which was defeated by content (an LTM entry documenting the header
 * format) serializing before the real header.
 *
 * Residual: these regexes are first-match, so a content block that reproduces
 * the whole sentinel AND serializes *before* the real header would still be
 * rewritten. In practice the real billing header is always the FIRST system
 * block (the worker prepends it via `buildBillingBlock`; Claude Code emits it
 * as system[0], which `BILLING_HEADER_RE` enforces with a `^` anchor), and
 * nothing in a serialized body precedes system[0] except the JSON envelope —
 * so no content can sort before it. The two-sentinel ordering is covered by a
 * regression test that locks in "real header (first block) wins".
 *
 * The value classes are intentionally permissive (`[^;]*`) for cc_version /
 * cc_entrypoint so we tolerate client variations (e.g. a missing 3-hex version
 * suffix), but the cch field is pinned to its exact shape (5 hex for a signed
 * value, `00000` for the placeholder).
 */
const BILLING_HEADER_PREFIX = String.raw`x-anthropic-billing-header:\s*cc_version=[^;]*;\s*cc_entrypoint=[^;]*;\s*`;

/**
 * Matches the billing header ending in the `cch=00000` placeholder. Group 1
 * is the entire header up to and including `cch=` so it is preserved on
 * replace; the `00000` is swapped for the computed hash.
 */
const BILLING_SIGN_RE = new RegExp(`(${BILLING_HEADER_PREFIX}cch=)0{5}`);

// ---------------------------------------------------------------------------
// Hash preimage transformation
// ---------------------------------------------------------------------------

/**
 * Strip the `model` value from a serialized body for cch hashing.
 * `"model":"<value>"` → `"model":""`. Matches the first occurrence only.
 */
const MODEL_VALUE_RE = /("model":")[^"]*(")/;

/**
 * Strip the `max_tokens` field (key + integer value + one adjacent comma) from
 * a serialized body for cch hashing.
 *
 * Claude Code (and our `buildAnthropicRequest`) always emit `max_tokens`
 * mid-object — `{"model":…,"max_tokens":N,"stream":…}` — so the trailing-comma
 * form is what the real binary strips (verified at the hash site; the preimage
 * has no leftover comma). We still match an optional LEADING comma as a
 * defensive fallback for the (currently-unseen) last-key position
 * `…,"max_tokens":N}`, removing exactly one comma either way so the surrounding
 * JSON stays well-formed. `max_tokens` is always a non-negative integer.
 *
 * The alternation removes exactly ONE comma: the trailing one when present
 * (`"max_tokens":N,` — the real binary's case), otherwise a leading one
 * (`,"max_tokens":N` — last-key fallback). It never strips both commas.
 */
const MAX_TOKENS_FIELD_RE = /"max_tokens":\d+,|,"max_tokens":\d+/;

/**
 * Transform a serialized request body into the exact byte sequence Claude Code
 * (>= 2.1.172) feeds to xxHash64 when computing the `cch` billing hash.
 *
 * Discovered by capturing the live hash input under a debugger (see
 * `quality/CCH.md`): the binary does NOT hash the raw wire body. It hashes the
 * body with three edits applied:
 *   1. `cch=<5hex>` → `cch=00000` (the placeholder; callers usually pre-apply this)
 *   2. the `model` VALUE removed: `"model":"sonnet-4"` → `"model":""`
 *   3. the `max_tokens` field removed: `"max_tokens":64000,` → `` (with comma)
 *
 * The seed (`0x4d659218e32a3268`) and algorithm (Zig-std xxHash64) are
 * unchanged from 2.1.166; only the preimage changed. Versions ≤ 2.1.170 hashed
 * the whole body, but we always pin WORKER_VERSION forward (≥ 2.1.172), so we
 * always strip. Both edits are no-ops when the field is absent (e.g. test
 * bodies or worker requests without `max_tokens`), keeping the function safe to
 * apply unconditionally.
 *
 * @param body — serialized JSON request body (the wire form)
 * @returns the byte-exact hash preimage
 */
function cchPreimage(body: string): string {
  return body.replace(MODEL_VALUE_RE, "$1$2").replace(MAX_TOKENS_FIELD_RE, "");
}

// ---------------------------------------------------------------------------
// First-block invariant verification
// ---------------------------------------------------------------------------

/**
 * The literal billing-header marker. The real header always starts with this;
 * we count occurrences to detect ambiguity.
 */
const BILLING_MARKER = "x-anthropic-billing-header:";

/**
 * Verify the invariant the anchored signer relies on: the body contains
 * exactly ONE `x-anthropic-billing-header:` marker.
 *
 * Both `signBody` and `resignBody` use first-match `.replace()` and trust that
 * the single match is the real header (always system[0], nothing precedes it).
 * That trust is only safe when the marker is unique. If a second sentinel
 * appears — e.g. an LTM entry reproducing the whole header, or Anthropic
 * reordering/duplicating system blocks — first-match could stamp the wrong
 * token and bust the entire prompt cache. We can't tell the real header from a
 * content copy by position alone, so any duplication is treated as a hazard.
 *
 * In practice this should never fire. When it does we surface it to Sentry as
 * an early warning. Report-only: signing proceeds unchanged (the real header is
 * still overwhelmingly likely to be first, so signing remains correct today).
 *
 * @param body — the serialized body being signed
 * @param caller — "signBody" | "resignBody" for the alert fingerprint
 */
function verifyBillingHeaderUnique(body: string, caller: string): void {
  const markerCount = body.split(BILLING_MARKER).length - 1;
  if (markerCount <= 1) {
    return; // unique (or absent) — invariant holds.
  }

  log.warn(
    `cch: billing-header first-block invariant violated in ${caller} ` +
      `(found ${markerCount} billing-header markers; expected 1) — ` +
      `first-match may sign the wrong token and bust the prompt cache`,
  );
  if (Sentry.isInitialized()) {
    Sentry.captureException(
      new Error(
        "cch: multiple billing-header sentinels in request body (cache-bust risk)",
      ),
      {
        fingerprint: [
          "LOREAI-GATEWAY",
          "cch-billing-header-not-unique",
          caller,
        ],
        extra: {
          caller,
          markerCount,
          bodyLength: body.length,
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Compute the `cch` hash for a JSON request body containing `cch=00000`.
 * Returns the body with the placeholder replaced by the computed hash.
 *
 * Only the billing-header placeholder is rewritten: the replacement is
 * anchored to the full `x-anthropic-billing-header: …` sentinel so a bare
 * `cch=00000` literal in conversation/LTM content is never touched (it lacks
 * the sentinel prefix). Because the real header is always system[0], no
 * content can serialize before it, so first-match always targets it.
 *
 * The hash is computed over the *preimage* (model value + max_tokens stripped;
 * see `cchPreimage`), NOT the raw body — but the placeholder is replaced in the
 * original body so the wire form keeps `model`/`max_tokens` intact.
 *
 * If no billing header is present the body is returned unchanged — there is
 * nothing to sign, and we must never rewrite a bare content `cch=00000`.
 *
 * @param bodyWithPlaceholder — JSON string containing a billing `cch=00000`
 * @returns body with the billing `cch=00000` replaced by `cch=XXXXX`
 */
export function signBody(bodyWithPlaceholder: string): string {
  if (!BILLING_SIGN_RE.test(bodyWithPlaceholder)) {
    return bodyWithPlaceholder; // no billing placeholder to sign
  }
  verifyBillingHeaderUnique(bodyWithPlaceholder, "signBody");

  const hash = xxHash64(cchPreimage(bodyWithPlaceholder), WORKER_SEED);
  const cch = (hash & 0xfffffn).toString(16).padStart(5, "0");
  return bodyWithPlaceholder.replace(BILLING_SIGN_RE, `$1${cch}`);
}

/**
 * Compute the 3-char hex cc_version suffix.
 *
 * Algorithm from the article:
 *   1. Take chars at indices 4, 7, 20 from the first user message
 *      (pad with '0' if message is shorter)
 *   2. suffix = sha256(salt + chars + version).hex()[:3]
 */
function computeVersionSuffix(firstUserMessage: string): string {
  const chars = [4, 7, 20]
    .map((i) => (i < firstUserMessage.length ? firstUserMessage[i] : "0"))
    .join("");
  return createHash("sha256")
    .update(`${WORKER_SALT}${chars}${WORKER_VERSION}`)
    .digest("hex")
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Re-signing conversation turn bodies
// ---------------------------------------------------------------------------

/**
 * Matches a full client-signed billing header in a serialized JSON body so
 * cc_version AND cch can be rewritten in a single anchored pass. We rewrite the
 * whole `cc_version=…;` and `cch=…;` segments wholesale (we don't need to
 * preserve the client's version/suffix — they're replaced with the worker's),
 * so only cc_entrypoint is captured for preservation:
 *
 *   group 1 = cc_entrypoint value (preserved verbatim)
 *
 * The cc_version value class is permissive: the suffix is optional and
 * case-insensitive (`cc_version=[^;]*`) so a client header that omits the
 * 3-hex suffix still re-signs rather than silently passing through a stale
 * cch (which upstream would reject). The cch value is pinned to its signed
 * shape (5 hex, case-insensitive).
 *
 * Anchored to the full `x-anthropic-billing-header:` sentinel so neither field
 * can be matched against a `cc_version=…;` / `cch=…;` token that appears in
 * LTM / system / message content — even if that content serializes BEFORE the
 * real header. Matching content would rewrite it every turn and bust the
 * entire prompt cache (the original incident's failure mode).
 *
 * The trailing `cch=…;` segment is OPTIONAL: Claude Code >= 2.1.181 omits it
 * entirely when it does not assume a first-party base URL (no
 * `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, e.g. a client launched outside
 * `lore run`/`lore setup`). When absent the replacement still emits the
 * `cch=00000;` placeholder, which `signBody` then signs — so a cch-less header
 * is re-signed exactly like a cch-bearing one (issue #807). The greedy optional
 * group consumes ` cch=<5hex>;` when present, so the cch-bearing match is
 * byte-identical to before.
 */
const BILLING_RESIGN_RE =
  /x-anthropic-billing-header:\s*cc_version=[^;]*;\s*cc_entrypoint=([^;]*);(?:\s*cch=[0-9a-fA-F]{5};)?/;

/**
 * Matches a full signed billing header for validation. Group 1 is the whole
 * header up to and including `cch=` (preserved on replace); group 2 is the
 * 5-hex signed value. Anchored so a content `cch=…;` token is never validated
 * in place of the real header.
 */
const BILLING_VALIDATE_RE = new RegExp(
  `(${BILLING_HEADER_PREFIX}cch=)([0-9a-fA-F]{5});`,
);

/**
 * Re-sign a serialized request body that contains a client-signed billing
 * header. Called after `buildAnthropicRequest` + `JSON.stringify` which
 * reconstructs the body (different JSON key ordering, cache_control
 * wrappers, message transforms) — invalidating the client's original cch.
 *
 * The function:
 *   1. Detects a full billing header — returns unchanged if absent
 *   2. Rewrites cc_version (worker version + recomputed suffix) AND cch
 *      (→ placeholder) in a single anchored pass over the header
 *   3. Hashes the resulting body with our known seed and stamps the cch
 *
 * @param serializedBody — JSON string after JSON.stringify(body)
 * @param firstUserMessage — text of the first user message (for version suffix)
 * @returns re-signed body, or original body if no billing header detected
 */
export function resignBody(
  serializedBody: string,
  firstUserMessage: string,
): string {
  // Quick check: no billing header → return unchanged. Anchored match ensures
  // a content cch=/cc_version= token never qualifies.
  if (!BILLING_RESIGN_RE.test(serializedBody)) {
    return serializedBody;
  }
  verifyBillingHeaderUnique(serializedBody, "resignBody");

  // Step 1+2: in a single anchored replace, swap cc_version for our worker
  // version + recomputed suffix and reset cch to the placeholder. cc_entrypoint
  // (group 1) is preserved verbatim. The suffix depends on chars[4,7,20] of the
  // first user message.
  //
  // The replacement ALWAYS emits `${CCH_PLACEHOLDER};` whether or not the client
  // header carried a `cch=…;` segment — cch-less headers (Claude Code >= 2.1.181
  // launched without _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL) get the
  // placeholder injected here, so signBody (below) always has something to sign
  // (issue #807).
  const suffix = computeVersionSuffix(firstUserMessage);
  const body = serializedBody.replace(
    BILLING_RESIGN_RE,
    (_m, entrypoint) =>
      `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.${suffix};` +
      ` cc_entrypoint=${entrypoint}; ${CCH_PLACEHOLDER};`,
  );

  // Step 3: Hash and replace placeholder with computed value (anchored).
  return signBody(body);
}

// ---------------------------------------------------------------------------
// Per-session bearer-token registry
// ---------------------------------------------------------------------------

/**
 * Regex to detect a billing header in a system prompt. The trailing `cch=…;`
 * segment is OPTIONAL: Claude Code >= 2.1.181 omits `cch` when it does not
 * assume a first-party base URL (no `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`),
 * but the header is still a real Claude Code OAuth billing header that must mark
 * the session and gate re-signing (issue #807). The `^` anchor is load-bearing —
 * only a real header at system[0] matches; a content-quoted sentinel (never at
 * offset 0) is correctly rejected.
 */
const BILLING_HEADER_RE =
  /^x-anthropic-billing-header:\s*cc_version=[^;]+;\s*cc_entrypoint=[^;]+;(?:\s*cch=[0-9a-fA-F]+;)?/;

/** Check if a system prompt contains the Claude Code billing header. */
export function hasBillingHeader(system: string): boolean {
  return BILLING_HEADER_RE.test(system);
}

/** Sessions that use bearer-token auth and need billing headers on workers. */
const sessionNeedsBilling = new Map<string, boolean>();

/**
 * Check if a system prompt contains a billing header and record the result
 * for this session. Called on each conversation turn. Returns true if the
 * session uses billing headers (bearer-token / Claude Code OAuth).
 *
 * Sessions whose system prompts do not match the regex (API-key clients,
 * non-Claude-Code clients) leave their slot untouched — a subsequent turn
 * without a billing header doesn't erase a previously recorded flag.
 */
export function captureBillingPrefix(
  sessionID: string,
  system: string,
): boolean {
  const hasBilling = BILLING_HEADER_RE.test(system);
  if (hasBilling) {
    sessionNeedsBilling.set(sessionID, true);
  }
  return hasBilling;
}

/**
 * Build a billing header system block for a worker request belonging to
 * `sessionID`. The header is pinned to WORKER_VERSION with a known seed
 * so the cch hash can be computed correctly.
 *
 * Returns null if the session doesn't use billing headers (API-key clients,
 * non-Claude-Code clients, or worker fired before the first turn).
 *
 * @param sessionID — originating session
 * @param userMessage — the worker's user message (used for version suffix)
 */
export function buildBillingBlock(
  sessionID: string | undefined,
  userMessage: string,
): { type: string; text: string } | null {
  if (!sessionID) return null;
  if (!sessionNeedsBilling.get(sessionID)) return null;

  const suffix = computeVersionSuffix(userMessage);
  return {
    type: "text",
    text:
      `x-anthropic-billing-header: cc_version=${WORKER_VERSION}.${suffix};` +
      ` cc_entrypoint=cli; ${CCH_PLACEHOLDER};`,
  };
}

/** Drop billing state for a session (used by session eviction). */
export function deleteBillingPrefix(sessionID: string): void {
  sessionNeedsBilling.delete(sessionID);
  sessionHeaderSnapshots.delete(sessionID);
}

/**
 * Whether a session is a Claude Code Anthropic OAuth session.
 *
 * True only when a Claude Code billing header was observed in the session's
 * system prompt (see `captureBillingPrefix`). This is the canonical signal
 * for "this bearer token is an Anthropic OAuth/subscription token" — a bearer
 * token for a non-Anthropic provider (OpenAI-protocol, MiniMax, vLLM, etc.)
 * never carries this header, so it is naturally excluded.
 *
 * Used to gate Anthropic-specific behavior (e.g. the OAuth usage/quota API)
 * to genuine Claude Code OAuth sessions only.
 */
export function isClaudeCodeOAuthSession(sessionID: string): boolean {
  return sessionNeedsBilling.get(sessionID) === true;
}

// ---------------------------------------------------------------------------
// Claude Code header sniffing & simulation for OAuth worker calls
// ---------------------------------------------------------------------------

/**
 * Minimal beta set for worker calls on OAuth sessions.
 * Workers send simple single-turn requests (no tools, no thinking, no
 * structured output) so only the base betas are needed. This matches
 * CortexKit's CLAUDE_CODE_BASE_BETAS for non-agent requests.
 *
 * NOTE: `extended-cache-ttl-2025-04-11` is included so workers' 1h TTL
 * cache_control breakpoints are actually honored by the API.
 */
const WORKER_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "extended-cache-ttl-2025-04-11",
  "prompt-caching-scope-2026-01-05",
].join(",");

/**
 * Per-session snapshot of headers observed on conversation turns.
 *
 * When the gateway sees a conversation turn from a Claude Code OAuth
 * session, it captures the `anthropic-beta` and `user-agent` values.
 * Worker calls for that session replay these headers so Anthropic sees
 * a consistent client fingerprint. Without this, worker calls using
 * OAuth tokens may be rejected because they lack the expected header set.
 *
 * Only populated for bearer-token sessions that have billing headers
 * (i.e. Claude Code OAuth). API-key sessions don't need this.
 */
type SessionHeaderSnapshot = {
  /** The anthropic-beta header from the last conversation turn. */
  anthropicBeta?: string;
  /** The user-agent header from the last conversation turn. */
  userAgent?: string;
  /** Codex (ChatGPT) `chatgpt-account-id` from the last conversation turn. */
  chatgptAccountId?: string;
  /** Codex `originator` header (e.g. "pi"). */
  originator?: string;
  /** Codex `OpenAI-Beta` header (e.g. "responses=experimental"). */
  openaiBeta?: string;
};

const sessionHeaderSnapshots = new Map<string, SessionHeaderSnapshot>();

/**
 * Capture Claude Code headers from a conversation turn for later replay
 * on worker calls. Called alongside `captureBillingPrefix()` on each turn.
 *
 * Only stores headers for sessions that use billing headers (bearer-token
 * OAuth). For API-key sessions this is a no-op.
 */
export function captureSessionHeaders(
  sessionID: string,
  rawHeaders: Record<string, string>,
): void {
  // Codex (ChatGPT) account/originator headers must be replayed on worker
  // calls to the `/codex/responses` backend. Capture them for ANY session
  // (Codex sessions don't set the Anthropic billing flag). Cheap: only stored
  // when present.
  const accountId =
    rawHeaders["chatgpt-account-id"] || rawHeaders["Chatgpt-Account-Id"];
  const originator = rawHeaders.originator || rawHeaders.Originator;
  const openaiBeta = rawHeaders["openai-beta"] || rawHeaders["OpenAI-Beta"];

  const hasCodexHeaders = !!(accountId || originator || openaiBeta);

  // Anthropic billing-header replay is gated to billing sessions (unchanged).
  if (!sessionNeedsBilling.get(sessionID) && !hasCodexHeaders) return;

  const snapshot: SessionHeaderSnapshot =
    sessionHeaderSnapshots.get(sessionID) ?? {};

  if (sessionNeedsBilling.get(sessionID)) {
    const beta = rawHeaders["anthropic-beta"] || rawHeaders["Anthropic-Beta"];
    if (beta) snapshot.anthropicBeta = beta;

    const ua = rawHeaders["user-agent"] || rawHeaders["User-Agent"];
    if (ua) snapshot.userAgent = ua;
  }

  if (accountId) snapshot.chatgptAccountId = accountId;
  if (originator) snapshot.originator = originator;
  if (openaiBeta) snapshot.openaiBeta = openaiBeta;

  sessionHeaderSnapshots.set(sessionID, snapshot);
}

/**
 * Build extra HTTP headers for an Anthropic worker request on an OAuth
 * session. Returns null for API-key sessions (no extra headers needed).
 *
 * For bearer-token sessions, builds the Claude Code header fingerprint:
 * - `anthropic-beta`: from sniffed session headers, or fallback worker set
 * - `user-agent`: from sniffed session headers, or fallback Claude Code UA
 * - `anthropic-dangerous-direct-browser-access`: required for OAuth
 * - `x-client-request-id`: fresh UUID per request
 *
 * This ensures worker calls (distillation, curation) present the same
 * client fingerprint as conversation turns, avoiding 401 rejections from
 * Anthropic's OAuth validation.
 */
/**
 * The `user-agent` to send on worker requests. Anthropic-compat providers
 * (e.g. MiniMax) reject requests that lack a recognized user-agent with a
 * generic auth-failure ("login fail: carry the API secret key in X-Api-Key"),
 * even when the key and host are correct — the conversation path works only
 * because it forwards the client's user-agent. Replay the session's sniffed
 * user-agent (captured in sessionHeaderSnapshots), falling back to a Claude
 * Code-style UA. Returns a value for ANY session, not just OAuth/billing ones.
 */
export function workerUserAgent(sessionID: string | undefined): string {
  const sniffed = sessionID
    ? sessionHeaderSnapshots.get(sessionID)?.userAgent
    : undefined;
  return sniffed || `claude-cli/${WORKER_VERSION} (external, sdk-cli)`;
}

export function buildOAuthWorkerHeaders(
  sessionID: string | undefined,
): Record<string, string> | null {
  if (!sessionID) return null;
  if (!sessionNeedsBilling.get(sessionID)) return null;

  const snapshot = sessionHeaderSnapshots.get(sessionID);

  return {
    "anthropic-beta": snapshot?.anthropicBeta || WORKER_BETAS,
    "user-agent":
      snapshot?.userAgent || `claude-cli/${WORKER_VERSION} (external, sdk-cli)`,
    "anthropic-dangerous-direct-browser-access": "true",
    "x-client-request-id": randomUUID(),
  };
}

/**
 * Build extra HTTP headers for an `openai-codex` worker request, replaying the
 * Codex (ChatGPT) fingerprint sniffed from the session's conversation turns.
 *
 * ChatGPT's `/backend-api/codex/responses` endpoint requires:
 * - `chatgpt-account-id`: the account ID (also embeddable from the JWT, but the
 *   client sends it explicitly — replay the observed value).
 * - `originator`: the client originator (e.g. "pi").
 * - `OpenAI-Beta`: `responses=experimental`.
 * - `session_id` / `x-client-request-id`: a stable per-session correlation id.
 *
 * Returns null when no Codex headers were ever observed for the session (the
 * caller then has nothing to add — the request will likely be rejected, which
 * is the correct loud failure rather than a silent malformed call).
 */
export function buildCodexWorkerHeaders(
  sessionID: string | undefined,
): Record<string, string> | null {
  if (!sessionID) return null;
  const snapshot = sessionHeaderSnapshots.get(sessionID);
  if (!snapshot?.chatgptAccountId) return null;

  const requestID = randomUUID();
  return {
    "chatgpt-account-id": snapshot.chatgptAccountId,
    originator: snapshot.originator || "codex",
    "OpenAI-Beta": snapshot.openaiBeta || "responses=experimental",
    session_id: sessionID,
    "x-client-request-id": requestID,
  };
}

// ---------------------------------------------------------------------------
// Seed resolution (with fallback for unknown versions)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into a comparable tuple.
 * Returns null if the string isn't a valid MAJOR.MINOR.PATCH format.
 */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare two semver tuples. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Resolve a seed for a given Claude Code version. Returns the exact seed if
 * known, otherwise falls back to the closest known version — preferring a
 * more recent version over an older one when equidistant.
 *
 * This allows the gateway to keep signing requests even when Claude Code
 * ships a new version before we've extracted its seed. The signing may
 * produce invalid cch values for those requests, but it's better than
 * omitting the billing header entirely (which causes hard 429s).
 *
 * @returns `{ version, seed, exact }` — `exact` is true when the seed is
 *          for the requested version, false when it's a fallback.
 */
export function resolveSeed(version: string): {
  version: string;
  seed: bigint;
  exact: boolean;
} {
  // Exact match
  if (VERSION_SEEDS[version]) {
    return { version, seed: VERSION_SEEDS[version], exact: true };
  }

  const target = parseSemver(version);
  const entries = Object.entries(VERSION_SEEDS)
    .map(([v, s]) => ({ version: v, seed: s, parsed: parseSemver(v) }))
    .filter(
      (e): e is typeof e & { parsed: [number, number, number] } =>
        e.parsed !== null,
    );

  if (entries.length === 0) {
    // Should never happen — VERSION_SEEDS is non-empty
    return { version: WORKER_VERSION, seed: WORKER_SEED, exact: false };
  }

  if (!target) {
    // Unparseable version string — use the latest known seed
    const latest = entries.sort((a, b) => compareSemver(b.parsed, a.parsed))[0];
    return { version: latest.version, seed: latest.seed, exact: false };
  }

  // Find closest version, preferring newer over older when equidistant.
  // Distance is measured as the absolute difference of flattened semver
  // (major*1e6 + minor*1e3 + patch).
  const flatten = (v: [number, number, number]) =>
    v[0] * 1_000_000 + v[1] * 1_000 + v[2];
  const targetFlat = flatten(target);

  let best = entries[0];
  let bestDist = Math.abs(flatten(best.parsed) - targetFlat);
  let bestIsNewer = compareSemver(best.parsed, target) >= 0;

  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    const dist = Math.abs(flatten(e.parsed) - targetFlat);
    const isNewer = compareSemver(e.parsed, target) >= 0;

    // Pick this entry if: closer, or same distance but newer (prefer recent)
    if (dist < bestDist || (dist === bestDist && isNewer && !bestIsNewer)) {
      best = e;
      bestDist = dist;
      bestIsNewer = isNewer;
    }
  }

  return { version: best.version, seed: best.seed, exact: false };
}

// ---------------------------------------------------------------------------
// Seed validation (for detecting seed rotation in live traffic)
// ---------------------------------------------------------------------------

/**
 * Validate our known seeds against a live (body, cch) pair from a
 * conversation turn. Returns true if any known seed produces the same cch.
 * If false, the client is using a version with an unknown seed.
 *
 * Call this on conversation turns where we see a signed cch from the
 * client's Claude Code binary. Extracts the cch, replaces it with the
 * placeholder, hashes with each known seed, and compares.
 *
 * @param body — the raw request body as received (with signed cch)
 * @returns null if no cch found, true if a seed matches, false if none match
 */
export function validateSeed(body: string): boolean | null {
  // Anchor to the full billing header so a cch= token in content can't be
  // mistaken for the signed billing cch. Group 1 = entire header up to and
  // including `cch=` (preserved); group 2 = the 5-hex signed value. cc_version
  // is intentionally left as-received — we validate the signature as sent.
  const cchMatch = body.match(BILLING_VALIDATE_RE);
  if (!cchMatch) return null;

  const clientCch = cchMatch[2].toLowerCase();
  // Group 1 already ends with `cch=`, so only the value + `;` follow.
  const bodyWithPlaceholder = body.replace(
    BILLING_VALIDATE_RE,
    (_m, prefix) => `${prefix}00000;`,
  );
  // Try both preimage forms: the new (>= 2.1.172) stripped form and the legacy
  // whole-body form (<= 2.1.170). A client on any known version then validates.
  const preimages = [cchPreimage(bodyWithPlaceholder), bodyWithPlaceholder];

  for (const seed of Object.values(VERSION_SEEDS)) {
    for (const preimage of preimages) {
      const hash = xxHash64(preimage, seed);
      const ourCch = (hash & 0xfffffn).toString(16).padStart(5, "0");
      if (ourCch === clientCch) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Reset module state for tests. */
export function _resetForTest(): void {
  sessionNeedsBilling.clear();
  sessionHeaderSnapshots.clear();
}

/** @internal Exposed for tests. */
export {
  WORKER_VERSION,
  WORKER_SEED,
  WORKER_SALT,
  CCH_PLACEHOLDER,
  VERSION_SEEDS,
  computeVersionSuffix as _computeVersionSuffix,
  parseSemver as _parseSemver,
  compareSemver as _compareSemver,
  cchPreimage as _cchPreimage,
};
