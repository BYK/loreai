/**
 * Cost attribution: resolve (provider, authKind, account) for a proxied
 * request so cost rows and quota snapshots can be grouped per upstream
 * provider/account (issue #1926).
 */

import { createHash } from "node:crypto";
import type { ProviderAuthKind } from "@loreai/core";
import {
  authFingerprint,
  credentialTenantFingerprint,
  type AuthCredential,
} from "./auth";
import { isCanonicalChatGPTBackend } from "./chatgpt-backend";
import { providerForUpstreamURL } from "./config";

export type CostAttribution = {
  provider: string;
  authKind: ProviderAuthKind;
  account: string;
};

const MAX_ANTHROPIC_ACCOUNT_KEYS = 256;
const MAX_ANTHROPIC_ORGANIZATION_ID_LENGTH = 128;
const MAX_ANTHROPIC_SUBSCRIPTION_CREDENTIALS = 256;
const MAX_OPENAI_SUBSCRIPTION_CREDENTIALS = 256;
// These identity sets are admission-only: evicting a trusted credential could
// reclassify its account and bypass established account-scoped pacing settings.
type AnthropicAccountCacheEntry = { account: string; observedAt: number };
const anthropicAccounts = new Map<string, AnthropicAccountCacheEntry>();
const anthropicSessionAccounts = new Map<string, AnthropicAccountCacheEntry>();
const anthropicSubscriptionCredentials = new Set<string>();
const openAISubscriptionCredentials = new Set<string>();

function isCanonicalAnthropicBackend(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://api.anthropic.com";
  } catch {
    return false;
  }
}

function isCanonicalDirectAnthropicResponse(
  responseURL: string | undefined,
  upstreamURL: string | undefined,
): boolean {
  // upstreamFetch uses manual redirects and rejects redirects. Bun may leave
  // Response.url empty, so the direct request target is authoritative then.
  return isCanonicalAnthropicBackend(responseURL?.trim() || upstreamURL);
}

/**
 * Trust an Anthropic OAuth credential only after it succeeds against the
 * canonical API. A billing header or OAuth-looking token prefix alone is a
 * caller-controlled signal and never establishes subscription auth.
 */
export function recordSuccessfulAnthropicOAuthAuth(input: {
  credential?: AuthCredential | null;
  upstreamURL?: string;
  responseURL?: string;
  responseStatus: number;
  directUpstreamResponse: boolean;
}): void {
  const { credential } = input;
  if (
    !input.directUpstreamResponse ||
    input.responseStatus < 200 ||
    input.responseStatus >= 300 ||
    !isCanonicalAnthropicBackend(input.upstreamURL) ||
    !isCanonicalDirectAnthropicResponse(input.responseURL, input.upstreamURL) ||
    credential?.scheme !== "bearer" ||
    !credential.value.startsWith("sk-ant-oat")
  ) {
    return;
  }

  const fingerprint = credentialTenantFingerprint(credential);
  if (
    anthropicSubscriptionCredentials.has(fingerprint) ||
    anthropicSubscriptionCredentials.size <
      MAX_ANTHROPIC_SUBSCRIPTION_CREDENTIALS
  ) {
    anthropicSubscriptionCredentials.add(fingerprint);
  }
}

/** True only for a credential accepted by Anthropic's canonical API. */
export function isVerifiedAnthropicOAuthCredential(
  credential?: AuthCredential | null,
): boolean {
  return (
    credential?.scheme === "bearer" &&
    anthropicSubscriptionCredentials.has(
      credentialTenantFingerprint(credential),
    )
  );
}

/** Candidate predicate used only to snapshot pacing state before dispatch. */
export function isPotentialAnthropicOAuthCredential(input: {
  providerID?: string;
  upstreamURL?: string;
  credential?: AuthCredential | null;
}): boolean {
  return (
    resolveProvider(input.providerID, input.upstreamURL) === "anthropic" &&
    input.credential?.scheme === "bearer" &&
    input.credential.value.startsWith("sk-ant-oat") &&
    isCanonicalAnthropicBackend(input.upstreamURL)
  );
}

/**
 * Record a bearer credential only after a direct successful response from
 * ChatGPT's canonical backend. Route IDs, caller-selected upstreams, and
 * response headers alone never establish subscription authentication.
 */
export function recordSuccessfulChatGPTAuth(input: {
  credential?: AuthCredential | null;
  upstreamURL?: string;
  responseURL?: string;
  responseStatus: number;
  directUpstreamResponse: boolean;
}): void {
  const { credential } = input;
  if (
    !input.directUpstreamResponse ||
    input.responseStatus < 200 ||
    input.responseStatus >= 300 ||
    !isCanonicalChatGPTBackend(input.upstreamURL) ||
    (input.responseURL !== undefined &&
      input.responseURL !== "" &&
      !isCanonicalChatGPTBackend(input.responseURL)) ||
    credential?.scheme !== "bearer"
  ) {
    return;
  }

  const fingerprint = credentialTenantFingerprint(credential);
  if (
    openAISubscriptionCredentials.has(fingerprint) ||
    openAISubscriptionCredentials.size < MAX_OPENAI_SUBSCRIPTION_CREDENTIALS
  ) {
    openAISubscriptionCredentials.add(fingerprint);
  }
}

/** Candidate predicate used only to snapshot pacing state before dispatch. */
export function isPotentialChatGPTSubscription(input: {
  providerID?: string;
  upstreamURL?: string;
  credential?: AuthCredential | null;
}): boolean {
  return (
    resolveProvider(input.providerID, input.upstreamURL) === "openai" &&
    input.credential?.scheme === "bearer" &&
    isCanonicalChatGPTBackend(input.upstreamURL)
  );
}

function anthropicOrganizationKey(
  credential: AuthCredential | null | undefined,
): string[] {
  const keys: string[] = [];
  if (credential?.value) {
    keys.push(`credential:${authFingerprint(credential)}`);
  }
  return keys;
}

function anthropicSessionKey(
  sessionID: string,
  credential: AuthCredential | null | undefined,
): string | null {
  // A session may switch credentials; never let one credential inherit another's organization.
  if (!credential?.value) return null;
  return `session:${sha256(sessionID)}:credential:${authFingerprint(credential)}`;
}

function rememberAnthropicOrganization(
  organizationID: string,
  credential: AuthCredential | null | undefined,
  sessionID: string | undefined,
  observedAt: number,
): void {
  if (organizationID.length > MAX_ANTHROPIC_ORGANIZATION_ID_LENGTH) return;
  const account = sha256(organizationID).slice(0, 12);
  const keys = anthropicOrganizationKey(credential);
  const sessionKey = sessionID
    ? anthropicSessionKey(sessionID, credential)
    : null;
  const latestObservedAt = Math.max(
    ...keys.map((key) => anthropicAccounts.get(key)?.observedAt ?? -Infinity),
    sessionKey
      ? (anthropicSessionAccounts.get(sessionKey)?.observedAt ?? -Infinity)
      : -Infinity,
  );
  // Quota persistence orders observations by request start. Keep the cache on
  // that same clock so a stale response with a newly-seen window cannot rewind
  // the credential's organization identity.
  if (observedAt < latestObservedAt) return;
  const entry = { account, observedAt };
  for (const key of keys) {
    // Cache only opaque account keys. New sessions may not evict established
    // credential ownership when the bounded cache is full.
    if (
      !anthropicAccounts.has(key) &&
      anthropicAccounts.size >= MAX_ANTHROPIC_ACCOUNT_KEYS
    ) {
      continue;
    }
    anthropicAccounts.delete(key);
    anthropicAccounts.set(key, entry);
  }
  if (
    sessionKey &&
    (anthropicSessionAccounts.has(sessionKey) ||
      anthropicSessionAccounts.size < MAX_ANTHROPIC_ACCOUNT_KEYS)
  ) {
    anthropicSessionAccounts.set(sessionKey, entry);
  }
}

function cachedAnthropicAccountForKeys(
  credential: AuthCredential | null | undefined,
  sessionID: string | undefined,
): string | null {
  if (sessionID) {
    const sessionKey = anthropicSessionKey(sessionID, credential);
    if (sessionKey) {
      const entry = anthropicSessionAccounts.get(sessionKey);
      if (entry !== undefined) return entry.account;
    }
  }
  for (const key of anthropicOrganizationKey(credential)) {
    const entry = anthropicAccounts.get(key);
    if (entry === undefined) continue;
    anthropicAccounts.delete(key);
    anthropicAccounts.set(key, entry);
    return entry.account;
  }
  return null;
}

export function _resetCostAttributionForTest(): void {
  anthropicAccounts.clear();
  anthropicSessionAccounts.clear();
  anthropicSubscriptionCredentials.clear();
  openAISubscriptionCredentials.clear();
}

function providerFromHost(hostname: string, upstreamURL: string): string {
  const host = hostname.toLowerCase();
  // Codex lives on ChatGPT's host but stays grouped under "openai" — the
  // subscription auth kind is what distinguishes it from API-key traffic.
  // Checked before the route table so "openai-codex" never surfaces here.
  if (host === "chatgpt.com") return "openai";
  const routed = providerForUpstreamURL(upstreamURL);
  if (routed) return routed;
  // Vertex endpoints are <region>-aiplatform.googleapis.com.
  if (host.endsWith("aiplatform.googleapis.com")) return "vertex";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    return "openrouter";
  }
  if (/^bedrock(?:[.-]|$)/.test(host) && host.endsWith(".amazonaws.com")) {
    return "bedrock";
  }
  return host || "unknown";
}

function resolveProvider(
  providerID: string | undefined,
  upstreamURL: string | undefined,
): string {
  const trimmed = providerID?.trim().toLowerCase();
  // The Codex route id still groups under OpenAI — subscription auth kind is
  // what distinguishes it from API-key traffic.
  if (trimmed === "openai-codex") return "openai";
  if (trimmed) return trimmed;
  if (!upstreamURL) return "unknown";
  try {
    return providerFromHost(new URL(upstreamURL).hostname, upstreamURL);
  } catch {
    return "unknown";
  }
}

function headerValue(
  headers: Headers | Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  let value: string | undefined | null;
  if (headers instanceof Headers) {
    value = headers.get(name);
  } else {
    const target = name.toLowerCase();
    const entry = Object.entries(headers).find(
      ([header]) => header.toLowerCase() === target,
    );
    value = entry?.[1];
  }
  const trimmed = value?.trim();
  return trimmed || null;
}

function anthropicOrganizationID(
  headers: Headers | null | undefined,
): string | null {
  const organizationID = headerValue(headers, "anthropic-organization-id");
  // Reject oversized provider values before they can select or cache an account.
  return organizationID !== null &&
    organizationID.length <= MAX_ANTHROPIC_ORGANIZATION_ID_LENGTH
    ? organizationID
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Resolve the attribution tuple for one upstream request/response.
 *
 * - `provider`: explicit providerID when present, else inferred from the
 *   upstream URL host, else "unknown".
 * - `authKind`: "subscription" for Anthropic OAuth (Claude Code) and ChatGPT
 *   Codex backends, else "api_key".
 * - `account`: a non-reversible key — never the raw credential. Use a cached
 *   Anthropic organization key when known, the stable default bucket for
 *   subscriptions without a trusted account ID, and a credential fingerprint
 *   for API-key traffic.
 */
export function resolveCostAttribution(input: {
  sessionID?: string;
  providerID?: string;
  upstreamURL?: string;
  credential?: AuthCredential | null;
  responseHeaders?: Headers | null;
  responseURL?: string;
  responseStatus?: number;
  directUpstreamResponse?: boolean;
  /** Forwarding hints only; never use caller-supplied headers as account identity. */
  requestHeaders?: Headers | Record<string, string> | null;
}): CostAttribution {
  const { sessionID, providerID, upstreamURL, credential, responseHeaders } =
    input;
  const provider = resolveProvider(providerID, upstreamURL);
  const trustedAnthropicResponse =
    input.directUpstreamResponse === true &&
    input.responseStatus !== undefined &&
    input.responseStatus >= 200 &&
    input.responseStatus < 300 &&
    isCanonicalAnthropicBackend(upstreamURL) &&
    isCanonicalDirectAnthropicResponse(input.responseURL, upstreamURL);
  const responseAnthropicOrganizationID =
    provider === "anthropic" && trustedAnthropicResponse
      ? anthropicOrganizationID(responseHeaders)
      : null;
  // API-key credentials remain API-key traffic on every route and backend.
  // A bearer credential is a subscription only at OpenAI's canonical backend;
  // route IDs, caller headers, JWT claims, and response headers are not proof.
  const openAISubscription =
    provider === "openai" &&
    credential?.scheme === "bearer" &&
    isCanonicalChatGPTBackend(upstreamURL) &&
    openAISubscriptionCredentials.has(credentialTenantFingerprint(credential));
  const anthropicSubscription =
    provider === "anthropic" &&
    isCanonicalAnthropicBackend(upstreamURL) &&
    isVerifiedAnthropicOAuthCredential(credential);

  const authKind: ProviderAuthKind =
    anthropicSubscription || openAISubscription ? "subscription" : "api_key";

  // OpenAI has no trusted stable account ID here; token fingerprints split
  // subscription state on credential rotation, and forwarded account hints are
  // not identity proof, so subscriptions share the stable default bucket.
  const account =
    authKind === "subscription" && provider === "anthropic"
      ? (cachedAnthropicAccountForKeys(credential, sessionID) ??
        (responseAnthropicOrganizationID
          ? sha256(responseAnthropicOrganizationID).slice(0, 12)
          : "default"))
      : authKind === "api_key" && credential?.value
        ? authFingerprint(credential).slice(0, 12)
        : "default";

  return { provider, authKind, account };
}

/** Cache a provider organization only after its quota observation persists. */
export function cacheAnthropicOrganizationFromResponse(input: {
  provider: string;
  credential?: AuthCredential | null;
  sessionID?: string;
  observedAt: number;
  responseHeaders?: Headers | null;
  upstreamURL?: string;
  responseURL?: string;
  directUpstreamResponse: boolean;
}): void {
  if (input.provider !== "anthropic") return;
  if (
    !input.directUpstreamResponse ||
    !isCanonicalAnthropicBackend(input.upstreamURL) ||
    !isCanonicalDirectAnthropicResponse(input.responseURL, input.upstreamURL) ||
    !isVerifiedAnthropicOAuthCredential(input.credential)
  ) {
    return;
  }
  const organizationID = anthropicOrganizationID(input.responseHeaders);
  if (organizationID) {
    rememberAnthropicOrganization(
      organizationID,
      input.credential,
      input.sessionID,
      input.observedAt,
    );
  }
}

/** Resolve a cached organization identity without accepting response hints. */
export function cachedAnthropicAccount(
  credential: AuthCredential | null | undefined,
  sessionID: string | undefined,
): string | null {
  return cachedAnthropicAccountForKeys(credential, sessionID);
}
