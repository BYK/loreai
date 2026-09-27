/** Harness names the gateway can attribute a proxied request to. */
export const KNOWN_HARNESSES = Object.freeze([
  "claude-code",
  "codex",
  "opencode",
  "pi",
] as const);

/** Harness (client program) that sent a proxied request, when the request identifies it. */
export function detectHarness(
  rawHeaders: Record<string, string>,
): string | undefined {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (!(lower in headers)) headers[lower] = value;
  }
  const present = (name: string) => {
    const v = headers[name];
    return v !== undefined && v.trim() !== "";
  };
  if (present("x-claude-code-session-id")) return "claude-code";
  // Only the OpenCode plugin sends x-lore-agent; its value is OpenCode's
  // internal agent name (e.g. "build"), not a harness.
  if (present("x-lore-agent")) return "opencode";
  const originator = headers["originator"]?.trim().toLowerCase();
  if (originator === "codex_cli_rs") return "codex";
  if (originator === "pi") return "pi";
  const ua = headers["user-agent"] ?? "";
  if (ua.startsWith("claude-cli/")) return "claude-code";
  if (ua.startsWith("codex_cli_rs/")) return "codex";
  return undefined;
}
