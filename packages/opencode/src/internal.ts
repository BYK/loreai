/**
 * Internal helpers for the Lore OpenCode plugin.
 *
 * These functions are intentionally kept OUT of the plugin entry module
 * (`./index.ts`). OpenCode's legacy plugin loader treats EVERY function
 * exported from a plugin module as a plugin instance and invokes it (see
 * `getServerPlugin`/`getLegacyPlugins` in opencode's plugin loader). Exporting
 * these helpers from the entry module caused them to be invoked as plugins and
 * their return values pushed into the host's hooks array:
 * `applyLoreProviderConfig` returns `undefined`, so the host crashed on the
 * first hook dispatch with `undefined is not an object (evaluating 'A.event')`
 * (the `?.` guards the `.event` property, not the `undefined` hook element).
 * Keeping them in a separate module means the entry module exposes only the
 * plugin function itself, while tests can still import them here.
 */

/**
 * Pin every opencode provider's `options.baseURL` to the Lore gateway.
 * Without this, opencode can derive the Anthropic baseURL from
 * `OPENAI_BASE_URL` (stripping `/v1`), sending the SDK to
 * `http://host/messages` (no /v1) — the gateway only routes `/v1/messages`,
 * and the fetch interceptor skips 127.0.0.1 to avoid loops, so the call
 * lands as a bare `/messages` 404. Worse, the `OPENAI_BASE_URL` /
 * `ANTHROPIC_BASE_URL` env vars are bypassed by opencode's `resolveSDK()`
 * (it always passes `options.baseURL` to the @ai-sdk factory, and the
 * @ai-sdk `loadOptionalSetting()` only consults the env var when the
 * factory receives an undefined `baseURL`). Every other @ai-sdk provider
 * (google, mistral, groq, cohere, xai, perplexity, togetherai, vercel,
 * alibaba, deepinfra, gateway, openrouter, cerebras, etc.) has NO
 * baseURL env var at all. Iterating over `cfg.provider` is the only
 * universal lever.
 *
 * Deep-merges per-provider so user-set keys under `provider.<id>` (custom
 * headers, model overrides, etc.) are preserved.
 *
 * Exported for direct testing — the config hook delegates here so unit tests
 * can verify the merge logic without spinning up a real gateway (the
 * surrounding `LorePlugin` skips gateway start in `NODE_ENV=test`).
 */
export function applyLoreProviderConfig(
  cfg: Record<string, unknown>,
  gatewayBase: string,
): void {
  if (!gatewayBase) return;
  const baseUrl = `${gatewayBase}/v1`;
  const existingProvider = (cfg.provider ?? {}) as Record<string, unknown>;
  const pinned: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(existingProvider)) {
    if (!provider || typeof provider !== "object") continue;
    const p = provider as Record<string, unknown>;
    const existingOptions = (p.options ?? {}) as Record<string, unknown>;
    pinned[id] = {
      ...p,
      options: { ...existingOptions, baseURL: baseUrl },
    };
  }
  if (Object.keys(pinned).length > 0) {
    cfg.provider = { ...existingProvider, ...pinned };
  }
}

/**
 * Check if the Lore gateway is reachable at the given base URL.
 * Short timeout so this doesn't delay OpenCode startup noticeably.
 */
export async function probeGateway(
  baseURL: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseURL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
