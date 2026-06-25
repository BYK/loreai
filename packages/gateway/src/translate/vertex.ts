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
 * Resolve the Vertex aiplatform host for a region. The `global` endpoint is
 * special-cased: it is served from the BARE `aiplatform.googleapis.com` host
 * (NOT `global-aiplatform.googleapis.com`, which resolves but 404s on the
 * rawPredict path — verified live against a real project). Every regional
 * endpoint uses the `{region}-aiplatform.googleapis.com` prefix form. The URL
 * path still carries `locations/global` for the global endpoint.
 */
export function vertexHost(region: string): string {
  return region === "global"
    ? "aiplatform.googleapis.com"
    : `${region}-aiplatform.googleapis.com`;
}

/**
 * Build the Vertex AI `rawPredict`/`streamRawPredict` URL.
 *
 * Format:
 *   https://{host}/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:{verb}
 * where {host} is `aiplatform.googleapis.com` for the global endpoint and
 * `{region}-aiplatform.googleapis.com` for regional endpoints (see vertexHost).
 */
export function vertexRawPredictUrl(
  region: string,
  project: string,
  model: string,
  stream: boolean,
): string {
  const verb = stream ? "streamRawPredict" : "rawPredict";
  // Encode the model id for safe path use, but PRESERVE a literal "@": Vertex
  // model ids carry an "@YYYYMMDD" date suffix, and every published Vertex
  // example (and Google's own SDK) puts the unencoded "@" in the path — it is a
  // valid RFC 3986 `pchar`, so no encoding is required. Emitting "%40" instead
  // risks a 404 on every dated model id; the literal "@" is the doc-matching,
  // round-trip-safe form. (`encodeURIComponent` would otherwise turn "@"→"%40";
  // nothing else in a Claude model id needs encoding.)
  const encodedModel = encodeURIComponent(model).replace(/%40/g, "@");
  return `https://${vertexHost(region)}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${encodedModel}:${verb}`;
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

/**
 * Matches a Vertex aiplatform host and captures the region segment. The region
 * prefix is OPTIONAL: the bare `aiplatform.googleapis.com` is the global
 * endpoint (region segment absent → treated as `"global"`), while
 * `{region}-aiplatform.googleapis.com` carries an explicit region. The legacy
 * `global-aiplatform.googleapis.com` form also parses (captures `"global"`) so a
 * manually-configured upstream self-heals to the bare host on the next rebuild.
 */
const VERTEX_HOST_RE = /^(?:([a-z0-9-]+)-)?aiplatform\.googleapis\.com$/;

/**
 * Extract the Vertex region/endpoint segment from a base URL or host
 * (`https://us-east1-aiplatform.googleapis.com` → `"us-east1"`,
 * `aiplatform.googleapis.com` → `"global"`). Returns null when the host is not a
 * Vertex aiplatform endpoint. Authoritative source of a worker's region — it's
 * the session's actual upstream host.
 */
export function vertexRegionFromUrl(url: string): string | null {
  try {
    const host = url.includes("://") ? new URL(url).hostname : url;
    const m = host.match(VERTEX_HOST_RE);
    // m[1] is undefined for the bare `aiplatform.googleapis.com` global host.
    return m ? (m[1] ?? "global") : null;
  } catch {
    return null;
  }
}

/**
 * True if `url` (a base URL or host) is a Vertex AI aiplatform endpoint — the
 * bare `aiplatform.googleapis.com` (global) or `{region}-aiplatform.googleapis.com`
 * (regional, including the legacy `global-aiplatform…`). Used to recognize a
 * Vertex session for worker/warmer model remapping when routing was set via
 * `LORE_UPSTREAM_*` rather than the provider header.
 */
export function isVertexHost(url: string): boolean {
  return vertexRegionFromUrl(url) !== null;
}

/** HTTP headers that only `api.anthropic.com` understands. They MUST be removed
 * before forwarding to Vertex's rawPredict endpoint:
 *   - `x-api-key`: replaced by the GCP OAuth2 bearer (set by the caller);
 *   - `anthropic-version`: carried in the body (`anthropic_version`) on Vertex;
 *   - `anthropic-beta`: an api.anthropic.com-only header. Prompt caching on
 *     Vertex is driven by `cache_control` body blocks (a GA feature), NOT a beta
 *     header, so dropping it never disables caching — but forwarding an
 *     unrecognized beta token (e.g. `extended-cache-ttl-…`) risks a 400. The
 *     documented Vertex header set is exactly content-type + Authorization (see
 *     https://docs.claude.com/en/api/claude-on-vertex-ai).
 */
const ANTHROPIC_ONLY_HEADERS = [
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
] as const;

/**
 * Apply the Vertex transport rewrite to an already-built Anthropic upstream
 * request (the `{ headers, body }` from `buildAnthropicRequest`). Pure and
 * synchronous so it is unit-testable in isolation — the caller supplies the
 * async-resolved GCP `project` and OAuth2 `token`. Produces the final Vertex
 * `:rawPredict` / `:streamRawPredict` request:
 *   - region: parsed from `effectiveUpstreamBase` so an explicit
 *     `X-Lore-Upstream-URL` regional endpoint (chosen for latency/compliance)
 *     wins, falling back to `configRegion`. In the no-override case
 *     `effectiveUpstreamBase` is the self-built `https://<vertexHost(configRegion)>`,
 *     so `vertexRegionFromUrl` round-trips `configRegion`;
 *   - url: the per-model rawPredict URL for that region/project (the verb
 *     selects streaming);
 *   - body: the Anthropic body with `model`/`stream` dropped and
 *     `anthropic_version` injected (`toVertexBody`);
 *   - headers: the forwarded Anthropic headers with the api.anthropic.com-only
 *     headers stripped (see `ANTHROPIC_ONLY_HEADERS`) and the GCP bearer set.
 */
export function buildVertexUpstream(opts: {
  anthropicHeaders: Record<string, string>;
  anthropicBody: Record<string, unknown>;
  effectiveUpstreamBase: string;
  configRegion: string;
  project: string;
  model: string;
  stream: boolean;
  token: string;
}): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const region =
    vertexRegionFromUrl(opts.effectiveUpstreamBase) ?? opts.configRegion;
  const url = vertexRawPredictUrl(
    region,
    opts.project,
    toVertexModelId(opts.model),
    opts.stream,
  );
  const body = toVertexBody(opts.anthropicBody);
  const headers = { ...opts.anthropicHeaders };
  for (const h of ANTHROPIC_ONLY_HEADERS) delete headers[h];
  headers.Authorization = `Bearer ${opts.token}`;
  return { url, headers, body };
}
