/**
 * Google Vertex AI authentication — GCP OAuth2 access tokens via Application
 * Default Credentials (ADC).
 *
 * Claude on Vertex is authenticated with a short-lived GCP OAuth2 bearer token
 * (NOT an API key). lore holds the GCP credentials (the gateway-holds-credentials
 * model, consistent with how it carries provider keys) and mints/refreshes
 * tokens via `google-auth-library`, so the client speaks plain Anthropic to lore.
 *
 * ADC resolves credentials from (in order): GOOGLE_APPLICATION_CREDENTIALS
 * (service-account key JSON), `gcloud auth application-default login` creds,
 * GCE/Cloud Run metadata server, and workload-identity federation —
 * google-auth-library picks the right source automatically. The library caches
 * the access token and refreshes it before expiry, so `getVertexAccessToken`
 * is cheap to call per request.
 */
import { GoogleAuth } from "google-auth-library";

/** OAuth2 scope required to call Vertex AI (aiplatform). */
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let auth: GoogleAuth | null = null;
let cachedProject: string | null = null;

// Test seam (NEVER set in production): inject a deterministic token provider so
// the Vertex routing/worker/warmer paths can be exercised without real GCP
// credentials (CI has none). `null` restores real ADC behavior.
let testTokenProvider: (() => Promise<string>) | null = null;

/** @internal test-only: inject (or clear with null) a fake access-token source. */
export function _setTestVertexTokenProvider(
  fn: (() => Promise<string>) | null,
): void {
  testTokenProvider = fn;
  cachedProject = null;
}

function getAuth(): GoogleAuth {
  if (!auth) auth = new GoogleAuth({ scopes: VERTEX_SCOPE });
  return auth;
}

/**
 * Obtain a GCP OAuth2 access token via ADC. The library caches + auto-refreshes,
 * so this is safe to call per request. Throws an actionable error when ADC is
 * unavailable (the request path surfaces it rather than sending an unauthorized
 * call upstream).
 */
export async function getVertexAccessToken(): Promise<string> {
  if (testTokenProvider) return testTokenProvider();
  let token: string | null | undefined;
  try {
    token = await getAuth().getAccessToken();
  } catch (err) {
    // Log the raw ADC failure to stderr so the operator can debug it, but do
    // NOT embed it in the thrown message: this Error can propagate to the
    // client (the conversation path surfaces it), and the raw ADC error may
    // reveal local file paths / project hints. Keep the client message generic
    // but actionable.
    console.error(
      "[lore] Vertex ADC token mint failed:",
      (err as Error).message,
    );
    throw new Error(
      "Vertex: failed to obtain a GCP access token via Application Default " +
        "Credentials. Run `gcloud auth application-default login`, or set " +
        "GOOGLE_APPLICATION_CREDENTIALS to a service-account key JSON.",
    );
  }
  if (!token) {
    throw new Error(
      "Vertex: Application Default Credentials returned no access token. Run " +
        "`gcloud auth application-default login`, or set " +
        "GOOGLE_APPLICATION_CREDENTIALS to a service-account key JSON.",
    );
  }
  return token;
}

/**
 * Resolve the GCP project id: prefer the explicitly-configured value
 * (GOOGLE_CLOUD_PROJECT / LORE_VERTEX_PROJECT), else derive it from ADC (e.g. a
 * service-account key's project, or the gcloud quota project). The derived
 * value is cached. Returns "" when neither is available (the request path then
 * fails with a clear "project not set" error).
 */
export async function resolveVertexProject(
  configured: string,
): Promise<string> {
  // Cache the configured project too: the conversation path resolves it with
  // config.vertexProject on the first turn, so a later warmer call (which has
  // no config in scope and passes "") reuses it — covers a LORE_VERTEX_PROJECT
  // that ADC's getProjectId() would not see.
  if (configured) {
    cachedProject = configured;
    return configured;
  }
  // Only short-circuit on a CACHED NON-EMPTY value. A previous empty/failed
  // ADC lookup must NEVER be cached as "" — that would permanently disable
  // Vertex for the process lifetime after a single transient metadata-server
  // hiccup. On empty/error we return "" without caching, so the next call
  // re-probes (the caller fails this turn with a clear "project not set" error
  // and recovers automatically once ADC provides a project).
  if (cachedProject) return cachedProject;
  try {
    const derived = (await getAuth().getProjectId()) ?? "";
    if (derived) cachedProject = derived;
    return derived;
  } catch {
    return "";
  }
}
