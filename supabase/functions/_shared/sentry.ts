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
// The DSN is a Sentry public key (not a secret) and is hard-coded below. An
// explicit SENTRY_DSN env var, if present, overrides it (e.g. for a staging
// project); otherwise instrumentation is always on.
import * as Sentry from "npm:@sentry/deno";

// Sentry DSN for the Lore project (o275100). This is a public key, safe to
// ship in client/server code — it only permits sending events, not reading them.
const SENTRY_DSN =
  "https://9b9cbf3a465080792e96fb919b278a38@o275100.ingest.us.sentry.io/4511812805394432";

let initialized = false;

/**
 * Initialize Sentry for a single edge function. Idempotent. An explicit
 * SENTRY_DSN env var, if set, overrides the built-in DSN.
 *
 * @param functionName - e.g. "github-discover"; tagged on every event so
 *   issues are filterable per function in the Sentry UI.
 */
export function initSentry(functionName: string): void {
  if (initialized) return;
  const dsn = Deno.env.get("SENTRY_DSN") ?? SENTRY_DSN;

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
 * Normalize a captured value into an Error. Supabase client errors
 * (e.g. PostgrestError) are plain objects, not Error instances; Sentry produces
 * weak events (missing/empty stack) for those, so we wrap them. Only scalar
 * message/hint are extracted — the raw object is NEVER JSON.stringify'd
 * because it may carry PII (query context, row contents).
 */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  const message =
    (err as { message?: unknown })?.message ??
    (err as { hint?: unknown })?.hint ??
    "edge function error";
  return new Error(
    typeof message === "string" ? message : "edge function error",
  );
}

/**
 * Capture an exception to Sentry and await the flush so the event is sent even
 * in a short-lived edge runtime that terminates right after the call. No-op
 * when Sentry isn't initialized (no DSN). Non-Error values (e.g. Supabase
 * PostgrestError) are normalized to Error so Sentry gets a real stack — no
 * tokens/emails/ids are attached.
 */
export async function capture(err: unknown): Promise<void> {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(toError(err));
  await Sentry.flush(2000);
}

/**
 * Wrap a Deno.serve handler so any uncaught throw is reported to Sentry and
 * converted into a generic 500 JSON (instead of an opaque edge-platform error),
 * preserving the function's existing response shape for handled cases. The
 * flush is awaited so the short-lived edge runtime sends the event before the
 * function returns and the runtime terminates.
 */
export function wrapHandler(
  functionName: string,
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err) {
      await capture(err);
      return new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  };
}
