/** Preserve account quota metadata independently of rewritten token usage. */
export function copyUsageLimitHeaders(source: Headers, target: Headers): void {
  const connectionHeaders = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  source.forEach((value, name) => {
    // Preserve provider units and windows verbatim, even across wire formats.
    // OpenAI-compatible APIs share x-ratelimit-*; gateways may use the
    // unprefixed fields. Codex has quota windows, named buckets, and credits.
    // Never copy arbitrary upstream headers (cookies, framing, credentials).
    if (
      (name.startsWith("anthropic-ratelimit-") ||
        name.startsWith("x-ratelimit-") ||
        name.startsWith("x-rate-limit-") ||
        name.startsWith("ratelimit-") ||
        name === "ratelimit" ||
        /^x-(?:[a-z0-9]+-)+(?:primary|secondary)-(?:used-percent|window-minutes|reset-at)$/.test(
          name,
        ) ||
        name === "x-codex-limit-name" ||
        (/^x-[a-z0-9-]+-limit-name$/.test(name) &&
          source.has(name.replace(/-limit-name$/, "-primary-used-percent"))) ||
        /^x-codex-credits-(?:has-credits|unlimited|balance)$/.test(name) ||
        name === "x-codex-rate-limit-reached-type") &&
      !connectionHeaders.has(name)
    ) {
      target.set(name, value);
    }
  });
}
