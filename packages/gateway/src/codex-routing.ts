import { extractAuth } from "./auth";
import type { GatewayConfig } from "./config";

/** ChatGPT's explicit account header selects its first-party backend only when
 * neither the caller nor the gateway administrator selected another route. */
export function isImplicitChatGPTResponses(
  headers: Record<string, string>,
  config: Pick<GatewayConfig, "upstreamOpenAI">,
): boolean {
  if (
    !headers["chatgpt-account-id"]?.trim() ||
    !extractAuth(headers) ||
    headers["x-lore-provider"] ||
    headers["x-lore-upstream-url"] ||
    headers["x-lore-upstream-path"]
  )
    return false;
  return [
    "https://api.openai.com",
    "https://api.openai.com/",
    "https://api.openai.com/v1",
    "https://api.openai.com/v1/",
  ].includes(config.upstreamOpenAI);
}
