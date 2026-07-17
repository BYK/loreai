/**
 * Human-friendly hints appended to upstream-error logs.
 *
 * Some upstream errors are routinely misread as Lore bugs. The clearest example:
 * a `429 rate_limit_error` on an Anthropic OAuth (Claude subscription) session.
 * Lore forwards the request verbatim exactly once and never retries a 429, so
 * the limit is the user's subscription rate limit — but the bare log line
 * (`upstream error: 429 {...}`) gives no signal of that, and users have reported
 * it as a suspected Lore bug.
 *
 * This module produces a short clarifying suffix for such cases. It is purely
 * diagnostic — it does NOT change pass-through behavior.
 */

export interface UpstreamErrorContext {
  /** HTTP status from the upstream response. */
  status: number;
  /** Raw (possibly truncated) upstream error body. */
  body: string;
  /** Effective upstream protocol for this request (e.g. "anthropic"). */
  protocol: string;
  /**
   * Auth scheme of the credential used for this turn, if known. OAuth/Claude
   * subscription tokens authenticate as `"bearer"`; API keys as `"api-key"`.
   */
  credScheme?: "bearer" | "api-key";
}

/**
 * Return a short, human-friendly hint to append to an upstream-error log line,
 * or `""` when no hint applies.
 *
 * Currently covers exactly one case (kept deliberately narrow to avoid noise):
 * an Anthropic `429 rate_limit_error` on a bearer (OAuth) credential.
 *
 * NOTE: Bedrock also reports `protocol === "anthropic"` but authenticates with
 * an `x-api-key` (`api-key` scheme), so it is excluded by the `bearer` check —
 * NOT by protocol. Known narrow limitation: routing an AWS Bedrock *bearer* API
 * key (a newer, non-default mantle path) through a 429 could misfire this hint.
 * That path is undocumented for mantle (which uses `x-api-key`) and low-risk.
 */
export function upstreamErrorHint(ctx: UpstreamErrorContext): string {
  if (
    ctx.status === 429 &&
    ctx.protocol === "anthropic" &&
    ctx.credScheme === "bearer" &&
    /rate_limit_error/.test(ctx.body)
  ) {
    return (
      " — this is your Anthropic subscription's rate limit, not a Lore issue. " +
      "Lore forwarded this request once and did not retry."
    );
  }
  return "";
}
