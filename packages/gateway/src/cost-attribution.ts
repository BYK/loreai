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
  // The Codex route only exists for ChatGPT subscriptions.
  const codexRoute = providerID?.trim().toLowerCase() === "openai-codex";
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
      codexRoute ||
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
