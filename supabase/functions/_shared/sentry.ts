// Shared Sentry instrumentation for Lore's Supabase Deno edge functions.
//
// Wires github-provision, github-discover and send-invite-email into the same
// Sentry project the gateway uses (o275100), so failures in the edge runtime
// are captured with stack traces + rate, just like the gateway.
//
// PRIVACY: these functions handle GitHub provider_tokens and invite emails.
// We NEVER attach PII to Sentry — no provider_token, no email address/body, no
// GitHub user id reaches setTag/setExtra. Only non-sensitive scalars are tagged
// (function_name, deployment, and boolean/status flags). sendDefaultPii is false.
//
// OPT-OUT: initSentry() is a no-op when SENTRY_DSN is unset, so a local
// `supabase start` stack (or any deploy without the secret) runs untouched.
import * as Sentry from "npm:@sentry/deno";

let initialized = false;

/**
 * Initialize Sentry for a single edge function. Idempotent and a no-op when
 * SENTRY_DSN is not configured in the function's environment.
 *
 * @param functionName - e.g. "github-discover"; tagged on every event so
 *   issues are filterable per function in the Sentry UI.
 */
export function initSentry(functionName: string): void {
  if (initialized) return;
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return; // local/dev without the secret — skip instrumentation

  Sentry.init({
    dsn,
    release: Deno.env.get("LORE_VERSION") ?? "dev",
    environment: Deno.env.get("SENTRY_ENVIRONMENT") ?? "production",
    // These functions are short-lived request handlers — skip transactions.
    tracesSampleRate: 0,
    // Never send request/response content or user IP-derived PII.
    sendDefaultPii: false,
    integrations: [],
  });

  Sentry.setTag("function_name", functionName);
  Sentry.setTag("deployment", "supabase-edge");
  initialized = true;
}

/**
 * Capture an exception to Sentry. No-op when Sentry isn't initialized (no DSN).
 * Pass only Error objects — never tokens, emails, or ids.
 */
export function capture(err: unknown): void {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(err);
}

/**
 * Wrap a Deno.serve handler so any uncaught throw is reported to Sentry and
 * converted into a generic 500 JSON (instead of an opaque edge-platform error),
 * preserving the function's existing response shape for handled cases.
 */
export function wrapHandler(
  functionName: string,
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err) {
      capture(err);
      return new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  };
}
