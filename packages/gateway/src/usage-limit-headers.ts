/** Preserve account quota metadata independently of rewritten token usage. */
export function copyUsageLimitHeaders(source: Headers, target: Headers): void {
  const connectionHeaders = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  source.forEach((value, name) => {
    // Claude Code reads its 5h/7d subscription windows from this namespace.
    // Never copy arbitrary upstream headers (cookies, framing, credentials).
    if (
      name.startsWith("anthropic-ratelimit-") &&
      !connectionHeaders.has(name)
    ) {
      target.set(name, value);
    }
  });
}
