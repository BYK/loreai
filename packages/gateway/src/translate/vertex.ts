/**
 * Google Vertex AI (Claude) ↔ Gateway translation helpers.
 *
 * Claude on Vertex speaks the native Anthropic Messages API with three
 * differences from `api.anthropic.com` (see
 * https://docs.claude.com/en/api/claude-on-vertex-ai):
 *   1. the model id is in the URL path (NOT the body);
 *   2. `anthropic_version: "vertex-2023-10-16"` goes in the BODY (not a header);
 *   3. streaming vs non-streaming is selected by the URL verb
 *      (`:streamRawPredict` vs `:rawPredict`), NOT a body `stream` field.
 *
 * Auth is GCP OAuth2 (Application Default Credentials) — see vertex-auth.ts.
 * The streaming wire format is plain Anthropic SSE and the non-streaming
 * response is the native Anthropic JSON shape, so both reuse the existing
 * Anthropic parsers — Vertex needs only the URL build, the body transform, and
 * the model-id remap below.
 */

/** Body field carrying the Vertex API version (replaces the HTTP header). */
export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

/**
 * Explicit client-model → Vertex-model-id overrides for models whose Vertex id
 * is NOT simply the client id. Sourced from the "Vertex AI API model ID" column
 * of https://docs.claude.com/en/api/claude-on-vertex-ai — Vertex pins some
 * models to a dated id (`@YYYYMMDD`) while the client sends the short id.
 * Newest models (opus-4-8/4-7/4-6, sonnet-4-6, fable-5) use the short id on
 * Vertex too and pass through. Verified against the published table; revisit
 * once we have live Vertex access to confirm exact strings.
 */
const VERTEX_MODEL_ALIASES: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5@20251001",
  "claude-sonnet-4-5": "claude-sonnet-4-5@20250929",
  "claude-opus-4-5": "claude-opus-4-5@20251101",
  "claude-sonnet-4": "claude-sonnet-4@20250514",
  "claude-opus-4-1": "claude-opus-4-1@20250805",
  "claude-opus-4": "claude-opus-4@20250514",
  "claude-3-5-haiku": "claude-3-5-haiku@20241022",
};

/**
 * Map a client Anthropic model id to a Vertex AI model id. Resolution order:
 *   1. explicit alias (own-key only — Object.hasOwn guards against a model
 *      literally named "valueOf"/"toString" resolving a prototype member);
 *   2. already a Vertex-dated id (`…@YYYYMMDD`) → unchanged;
 *   3. an Anthropic-dated id (`…-YYYYMMDD`) → convert the dash-date to Vertex's
 *      `@`-date form (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5@20250929`);
 *   4. otherwise unchanged (short ids like `claude-opus-4-8` pass through).
 */
export function toVertexModelId(model: string): string {
  if (Object.hasOwn(VERTEX_MODEL_ALIASES, model))
    return VERTEX_MODEL_ALIASES[model];
  if (model.includes("@")) return model;
  const dated = model.match(/^(.*)-(\d{8})$/);
  if (dated) return `${dated[1]}@${dated[2]}`;
  return model;
}

/**
 * Build the Vertex AI `rawPredict`/`streamRawPredict` URL.
 *
 * Format (regional and global both use the `{region}-aiplatform` host; for the
 * recommended `global` endpoint this is `global-aiplatform.googleapis.com` with
 * `locations/global`):
 *   https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:{verb}
 */
export function vertexRawPredictUrl(
  region: string,
  project: string,
  model: string,
  stream: boolean,
): string {
  const verb = stream ? "streamRawPredict" : "rawPredict";
  const encodedModel = encodeURIComponent(model);
  return `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${encodedModel}:${verb}`;
}

/**
 * Transform an Anthropic Messages body (as built by `buildAnthropicRequest`)
 * into the Vertex shape: drop `model` (it's in the URL path) and `stream` (the
 * URL verb controls streaming — a body `stream` field is rejected), and inject
 * `anthropic_version`. Returns a new object; the input is not mutated. All
 * other fields (system, messages, tools, cache_control, thinking, …) are
 * Vertex-compatible verbatim.
 */
export function toVertexBody(
  anthropicBody: Record<string, unknown>,
): Record<string, unknown> {
  const { model: _model, stream: _stream, ...rest } = anthropicBody;
  return { anthropic_version: VERTEX_ANTHROPIC_VERSION, ...rest };
}

/** Matches a Vertex aiplatform host and captures the region/endpoint segment. */
const VERTEX_HOST_RE = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/;

/**
 * Extract the Vertex region/endpoint segment from a base URL or host
 * (`https://us-east1-aiplatform.googleapis.com` → `"us-east1"`,
 * `global-aiplatform.googleapis.com` → `"global"`). Returns null when the host
 * is not a Vertex aiplatform endpoint. Authoritative source of a worker's
 * region — it's the session's actual upstream host.
 */
export function vertexRegionFromUrl(url: string): string | null {
  try {
    const host = url.includes("://") ? new URL(url).hostname : url;
    const m = host.match(VERTEX_HOST_RE);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * True if `url` (a base URL or host) is a Vertex AI aiplatform endpoint
 * (`{region}-aiplatform.googleapis.com`, including `global-aiplatform…`). Used
 * to recognize a Vertex session for worker/warmer model remapping when routing
 * was set via `LORE_UPSTREAM_*` rather than the provider header.
 */
export function isVertexHost(url: string): boolean {
  return vertexRegionFromUrl(url) !== null;
}
