/**
 * Cost attribution: resolve (provider, authKind, account) for a proxied
 * request so cost rows and quota snapshots can be grouped per upstream
 * provider/account (issue #1926).
 */

import { createHash } from "node:crypto";
import type { ProviderAuthKind } from "@loreai/core";
import { authFingerprint, type AuthCredential } from "./auth";
import { isChatGPTBackend } from "./chatgpt-backend";
import { isClaudeCodeOAuthSession, sessionChatGPTAccountId } from "./cch";

export type CostAttribution = {
  provider: string;
  authKind: ProviderAuthKind;
  account: string;
};

/** Hostname → canonical provider id. */
const PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "chatgpt.com": "openai",
  "generativelanguage.googleapis.com": "gemini",
  "openrouter.ai": "openrouter",
  "api.githubcopilot.com": "github-copilot",
};

function providerFromHost(hostname: string): string {
  const host = hostname.toLowerCase();
  const mapped = PROVIDER_HOSTS[host];
  if (mapped) return mapped;
  // Vertex endpoints are <region>-aiplatform.googleapis.com.
  if (host.endsWith("aiplatform.googleapis.com")) return "vertex";
  if (host.endsWith(".openrouter.ai")) return "openrouter";
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
  if (trimmed) return trimmed;
  if (!upstreamURL) return "unknown";
  try {
    return providerFromHost(new URL(upstreamURL).hostname);
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
 * - `account`: a non-reversible key — never the raw credential. ChatGPT
 *   subscription accounts prefer sha256(chatgpt-account-id); otherwise the
 *   credential fingerprint; otherwise "default".
 */
export function resolveCostAttribution(input: {
  sessionID?: string;
  providerID?: string;
  upstreamURL?: string;
  credential?: AuthCredential | null;
  responseHeaders?: Headers | null;
}): CostAttribution {
  const { sessionID, providerID, upstreamURL, credential, responseHeaders } =
    input;
  const provider = resolveProvider(providerID, upstreamURL);
  const chatgptAccountId = sessionChatGPTAccountId(sessionID);

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
      isChatGPTBackend(upstreamURL) ||
      chatgptAccountId !== null ||
      (responseHeaders && hasHeaderPrefix(responseHeaders, "x-codex-"))
    ) {
      authKind = "subscription";
    }
  }

  let account = "default";
  if (
    provider === "openai" &&
    authKind === "subscription" &&
    chatgptAccountId
  ) {
    account = sha256(chatgptAccountId).slice(0, 12);
  } else if (credential?.value) {
    account = authFingerprint(credential).slice(0, 12);
  }

  return { provider, authKind, account };
}
