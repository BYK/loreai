/**
 * AWS Bedrock (bedrock-mantle) ↔ Gateway helpers.
 *
 * Bedrock is reached via AWS's `bedrock-mantle` endpoint, which speaks the
 * NATIVE Anthropic Messages API (`/anthropic/v1/messages`) authenticated with a
 * Bedrock API key (`x-api-key`) and the `anthropic-version: 2023-06-01` header.
 * lore therefore routes Bedrock over its existing `anthropic` protocol — no
 * SigV4, no InvokeModel, no AWS binary event-stream decoding, no cross-region
 * inference profiles. The ONLY Bedrock-specific transforms are:
 *   1. the upstream base URL (region-specific), and
 *   2. the model-id remap (mantle catalog ids are `anthropic.<name>`,
 *      e.g. `anthropic.claude-opus-4-8`).
 *
 * Verified against the real endpoint: a Bedrock API key + this base URL + the
 * `anthropic-version` header returns native Anthropic responses (and proper
 * Anthropic error envelopes). Structured outputs (`output_config.format`) are
 * the one feature mantle does not support — clients needing them must use the
 * Bedrock-native InvokeModel/Converse APIs directly (not via lore).
 */

/**
 * Build the bedrock-mantle Anthropic Messages BASE URL for a region.
 *
 * Returns the `/anthropic` base (NOT the full `/v1/messages` path) — the
 * gateway's Anthropic upstream builder appends `/v1/messages` itself, exactly
 * as it does for api.anthropic.com.
 */
export function bedrockMantleUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/anthropic`;
}

/**
 * Decide whether a resolved provider route should dispatch as bedrock-mantle:
 * the route must carry `bedrockMantle: true` AND the effective wire protocol
 * must be `"anthropic"`.
 *
 * The protocol guard is load-bearing: the bedrock-mantle base-URL build and the
 * `body.model` remap live ONLY on the anthropic dispatch path. An ingress that
 * force-pins a non-anthropic protocol (e.g. "openai-responses") carrying
 * `X-Lore-Provider: bedrock` must NOT build the mantle URL — that would POST a
 * non-Anthropic wire shape with an un-remapped model to the mantle endpoint.
 * No real client produces that pairing (Bedrock Claude arrives as anthropic or
 * openai ingress), so this is defense-in-depth — but it keeps the invariant
 * `bedrockMantle ⟹ anthropic` explicit and is shared verbatim by the request
 * path (forwardToUpstream) and the snapshot path (postResponse) so they can
 * never diverge.
 */
export function isBedrockMantleDispatch(
  route: { bedrockMantle?: boolean } | null | undefined,
  effectiveProtocol: string,
): boolean {
  return route?.bedrockMantle === true && effectiveProtocol === "anthropic";
}

/**
 * True if `url` (a base URL or host) points at a bedrock-mantle endpoint
 * (`bedrock-mantle.<region>.api.aws`). Used to recognize a Bedrock session for
 * cache-warming even when no `X-Lore-Provider` header is present (e.g. a user
 * who set `LORE_UPSTREAM_ANTHROPIC` to the mantle URL directly).
 */
export function isBedrockMantleHost(url: string): boolean {
  try {
    const host = url.includes("://") ? new URL(url).hostname : url;
    return /^bedrock-mantle\.[^.]+\.api\.aws$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Optional explicit aliases for client model ids whose mantle catalog id is not
 * simply `anthropic.<clientModel>` (e.g. dated Anthropic ids that map to a
 * shorter mantle id). Empty by default — the `anthropic.`-prefix rule covers
 * the current-generation ids (`claude-opus-4-8` → `anthropic.claude-opus-4-8`).
 * Expand as needed once specific client→mantle id mismatches are confirmed.
 */
const MANTLE_MODEL_ALIASES: Record<string, string> = {};

/**
 * Map a client Anthropic model id to a bedrock-mantle model id.
 *
 * The mantle catalog uses `anthropic.<model>` ids (e.g. `anthropic.claude-opus-4-8`,
 * `anthropic.claude-haiku-4-5`). Resolution order:
 *   1. explicit alias (MANTLE_MODEL_ALIASES) — own-key only, to avoid resolving
 *      inherited Object.prototype members for a model literally named e.g.
 *      "valueOf";
 *   2. already in mantle format (`anthropic.`-prefixed) → unchanged;
 *   3. a `claude*` id → prefix with `anthropic.`;
 *   4. anything else → unchanged (let mantle reject unknown ids loudly).
 */
export function toMantleModelId(model: string): string {
  if (Object.hasOwn(MANTLE_MODEL_ALIASES, model))
    return MANTLE_MODEL_ALIASES[model];
  if (model.startsWith("anthropic.")) return model;
  if (model.startsWith("claude")) return `anthropic.${model}`;
  return model;
}
