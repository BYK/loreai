/**
 * Cost attribution: resolve (provider, authKind, account) for a proxied
 * request so cost rows and quota snapshots can be grouped per upstream
 * provider/account (issue #1926).
 */

import { createHash } from "node:crypto";
import type { ProviderAuthKind } from "@loreai/core";
import { authFingerprint, type AuthCredential } from "./auth";
import { isChatGPTBackend } from "./chatgpt-backend";
import { isClaudeCodeOAuthSession } from "./cch";
import { providerForUpstreamURL } from "./config";

export type CostAttribution = {
  provider: string;
  authKind: ProviderAuthKind;
  account: string;
};

const MAX_ANTHROPIC_ACCOUNT_KEYS = 256;
const MAX_ANTHROPIC_ORGANIZATION_ID_LENGTH = 128;
type AnthropicAccountCacheEntry = { account: string; observedAt: number };
const anthropicAccounts = new Map<string, AnthropicAccountCacheEntry>();
const anthropicSessionAccounts = new Map<string, AnthropicAccountCacheEntry>();

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

function hasHeaderPrefix(headers: Headers, prefix: string): boolean {
  for (const name of headers.keys()) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
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
 *   Anthropic organization key when known, otherwise a credential fingerprint;
 *   use "default" only when neither identity is available.
 */
export function resolveCostAttribution(input: {
  sessionID?: string;
  providerID?: string;
  upstreamURL?: string;
  credential?: AuthCredential | null;
  responseHeaders?: Headers | null;
  /** Forwarding hints only; never use caller-supplied headers as account identity. */
  requestHeaders?: Headers | Record<string, string> | null;
}): CostAttribution {
  const { sessionID, providerID, upstreamURL, credential, responseHeaders } =
    input;
  const provider = resolveProvider(providerID, upstreamURL);
  const responseAnthropicOrganizationID =
    provider === "anthropic"
      ? headerValue(responseHeaders, "anthropic-organization-id")
      : null;
  // The Codex route only exists for ChatGPT subscriptions.
  const codexRoute = providerID?.trim().toLowerCase() === "openai-codex";
  // Bearer JWT payloads are not signature-verified here. Their account claims
  // are untrusted and must never select an identity or subscription auth kind.

  let authKind: ProviderAuthKind = "api_key";
  if (provider === "anthropic") {
    if (
      (sessionID && isClaudeCodeOAuthSession(sessionID)) ||
      credential?.value.startsWith("sk-ant-oat") === true ||
      (responseHeaders &&
        hasHeaderPrefix(responseHeaders, "anthropic-ratelimit-unified-"))
    ) {
      authKind = "subscription";
    }
  } else if (provider === "openai") {
    if (
      codexRoute ||
      isChatGPTBackend(upstreamURL) ||
      (responseHeaders && hasHeaderPrefix(responseHeaders, "x-codex-"))
    ) {
      authKind = "subscription";
    }
  }

  let account = "default";
  if (authKind === "subscription") {
    if (provider === "openai" && credential?.value) {
      // Without a verified provider account claim, isolate pacing to this
      // credential instead of sharing one default bucket across accounts.
      account = authFingerprint(credential).slice(0, 12);
    } else if (provider === "anthropic") {
      account =
        cachedAnthropicAccountForKeys(credential, sessionID) ??
        (responseAnthropicOrganizationID
          ? sha256(responseAnthropicOrganizationID).slice(0, 12)
          : "default");
    }
  } else if (credential?.value) {
    account = authFingerprint(credential).slice(0, 12);
  }

  return { provider, authKind, account };
}

/** Cache a provider organization only after its quota observation persists. */
export function cacheAnthropicOrganizationFromResponse(input: {
  provider: string;
  credential?: AuthCredential | null;
  sessionID?: string;
  observedAt: number;
  responseHeaders?: Headers | null;
}): void {
  if (input.provider !== "anthropic") return;
  const organizationID = headerValue(
    input.responseHeaders,
    "anthropic-organization-id",
  );
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
