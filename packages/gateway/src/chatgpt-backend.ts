/**
 * True when a URL targets ChatGPT's `/backend-api` Codex backend
 * (https://chatgpt.com/backend-api). That backend serves only the Responses
 * API at `/backend-api/codex/responses` and authenticates via a ChatGPT
 * OAuth JWT rather than an OpenAI API key. The `/backend-api` path is
 * preserved by compatible proxies, unlike the host.
 *
 * Single shared implementation — previously duplicated in llm-adapter.ts
 * and worker-model.ts.
 */
import { buildCodexWorkerHeaders } from "./cch";

export function isChatGPTBackend(url: string | URL | undefined): boolean {
  if (!url) return false;
  try {
    const target = typeof url === "string" ? new URL(url) : url;
    return /(?:^|\/)backend-api(?:\/|$)/.test(target.pathname);
  } catch {
    return false;
  }
}

/**
 * The Codex (ChatGPT) `chatgpt-account-id` captured for a session, if any.
 * Its presence marks the session as ChatGPT-subscription-authenticated.
 * Reads through `buildCodexWorkerHeaders` so the session snapshot stays an
 * internal detail of cch.ts.
 */
export function sessionChatGPTAccountId(
  sessionID: string | undefined,
): string | null {
  return buildCodexWorkerHeaders(sessionID)?.["chatgpt-account-id"] ?? null;
}
