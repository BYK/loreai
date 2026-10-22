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

/** Match only OpenAI's canonical ChatGPT host, never a caller-selected proxy. */
export function isCanonicalChatGPTBackend(
  url: string | URL | undefined,
): boolean {
  if (!url) return false;
  try {
    const target = typeof url === "string" ? new URL(url) : url;
    return (
      target.protocol === "https:" &&
      target.hostname === "chatgpt.com" &&
      !target.username &&
      !target.password &&
      !target.port &&
      isChatGPTBackend(target)
    );
  } catch {
    return false;
  }
}

/**
 * The forwarded `chatgpt-account-id` hint captured for a session, if any.
 * This snapshot is not proof of provider account identity or auth kind.
 */
export function sessionChatGPTAccountId(
  sessionID: string | undefined,
): string | null {
  return buildCodexWorkerHeaders(sessionID)?.["chatgpt-account-id"] ?? null;
}
