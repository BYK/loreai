/**
 * Cost attribution: resolve (provider, authKind, account) for a proxied
 * request so cost rows and quota snapshots can be grouped per upstream
 * provider/account (issue #1926).
 */

import { createHash } from "node:crypto";
import type { ProviderAuthKind } from "@loreai/core";
import { authFingerprint, type AuthCredential } from "./auth";
import { isChatGPTBackend, sessionChatGPTAccountId } from "./chatgpt-backend";
import { isClaudeCodeOAuthSession } from "./cch";
import { providerForUpstreamURL } from "./config";

export type CostAttribution = {
  provider: string;
  authKind: ProviderAuthKind;
  account: string;
};

const MAX_ANTHROPIC_ORGANIZATION_KEYS = 256;
const anthropicOrganizations = new Map<string, string>();

function anthropicOrganizationKey(
  credential: AuthCredential | null | undefined,
  sessionID: string | undefined,
): string[] {
  const keys: string[] = [];
  if (credential?.value) {
    keys.push(`credential:${authFingerprint(credential)}`);
  }
  if (sessionID) keys.push(`session:${sessionID}`);
  return keys;
}

function rememberAnthropicOrganization(
  organizationID: string,
  credential: AuthCredential | null | undefined,
  sessionID: string | undefined,
): void {
  for (const key of anthropicOrganizationKey(credential, sessionID)) {
    anthropicOrganizations.delete(key);
    anthropicOrganizations.set(key, organizationID);
    if (anthropicOrganizations.size > MAX_ANTHROPIC_ORGANIZATION_KEYS) {
      const oldest = anthropicOrganizations.keys().next().value;
      if (oldest !== undefined) anthropicOrganizations.delete(oldest);
    }
  }
}

function cachedAnthropicOrganization(
  credential: AuthCredential | null | undefined,
  sessionID: string | undefined,
): string | null {
  for (const key of anthropicOrganizationKey(credential, sessionID)) {
    const organizationID = anthropicOrganizations.get(key);
    if (organizationID === undefined) continue;
    anthropicOrganizations.delete(key);
    anthropicOrganizations.set(key, organizationID);
    return organizationID;
  }
  return null;
}

export function _resetCostAttributionForTest(): void {
  anthropicOrganizations.clear();
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

function chatGPTAccountIdFromCredential(
  credential: AuthCredential | null | undefined,
): string | null {
  if (credential?.scheme !== "bearer") return null;
  const payloadPart = credential?.value.split(".")[1];
  if (!payloadPart || !/^[A-Za-z0-9_-]+$/.test(payloadPart)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId =
      payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" ? accountId.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the attribution tuple for one upstream request/response.
 *
 * - `provider`: explicit providerID when present, else inferred from the
 *   upstream URL host, else "unknown".
 * - `authKind`: "subscription" for Anthropic OAuth (Claude Code) and ChatGPT
 *   Codex backends, else "api_key".
 * - `account`: a non-reversible key — never the raw credential. Subscription
 *   accounts use a stable provider account id when available, otherwise
 *   "default"; API-key accounts use a credential fingerprint.
 */
export function resolveCostAttribution(input: {
  sessionID?: string;
  providerID?: string;
  upstreamURL?: string;
  credential?: AuthCredential | null;
  responseHeaders?: Headers | null;
  requestHeaders?: Headers | Record<string, string> | null;
}): CostAttribution {
  const {
    sessionID,
    providerID,
    upstreamURL,
    credential,
    responseHeaders,
    requestHeaders,
  } = input;
  const provider = resolveProvider(providerID, upstreamURL);
  const responseAnthropicOrganizationID =
    provider === "anthropic"
      ? headerValue(responseHeaders, "anthropic-organization-id")
      : null;
  if (responseAnthropicOrganizationID) {
    rememberAnthropicOrganization(
      responseAnthropicOrganizationID,
      credential,
      sessionID,
    );
  }
  // The Codex route only exists for ChatGPT subscriptions.
  const codexRoute = providerID?.trim().toLowerCase() === "openai-codex";
  const requestChatGPTAccountId = headerValue(
    requestHeaders,
    "chatgpt-account-id",
  );
  const sessionAccountId = sessionChatGPTAccountId(sessionID);
  const chatgptAccountId =
    requestChatGPTAccountId ??
    sessionAccountId ??
    (provider === "openai" ? chatGPTAccountIdFromCredential(credential) : null);

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
      chatgptAccountId !== null ||
      (requestHeaders &&
        hasHeaderPrefix(
          requestHeaders instanceof Headers
            ? requestHeaders
            : new Headers(requestHeaders),
          "x-codex-",
        )) ||
      (responseHeaders && hasHeaderPrefix(responseHeaders, "x-codex-"))
    ) {
      authKind = "subscription";
    }
  }

  let account = "default";
  if (authKind === "subscription") {
    const stableAccountId =
      provider === "openai"
        ? chatgptAccountId
        : provider === "anthropic"
          ? (responseAnthropicOrganizationID ??
            cachedAnthropicOrganization(credential, sessionID))
          : null;
    if (stableAccountId) account = sha256(stableAccountId).slice(0, 12);
  } else if (credential?.value) {
    account = authFingerprint(credential).slice(0, 12);
  }

  return { provider, authKind, account };
}
