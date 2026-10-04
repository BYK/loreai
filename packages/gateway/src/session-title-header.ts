/**
 * `x-lore-session-title` — harness-provided session title (#1921).
 *
 * Adapter plugins (OpenCode, Pi) send the harness's own session name so the
 * gateway can persist it as the session's explicit title. The header is
 * consumed here and stripped before forwarding — it is never meaningful to
 * upstream providers. Values are percent-encoded (header values must be
 * ASCII), so a malformed encoding or the harness's auto placeholder resolves
 * to `null`.
 */

export const LORE_SESSION_TITLE_HEADER = "x-lore-session-title";

const MAX_TITLE_LENGTH = 512;

/** OpenCode's default title before it generates a real one. */
const PLACEHOLDER_TITLE_RE = /^new session\b/i;

/** Decode + sanitize a raw `x-lore-session-title` value. */
export function parseHarnessSessionTitle(
  raw: string | undefined,
): string | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const title = decoded.trim();
  if (title === "" || PLACEHOLDER_TITLE_RE.test(title)) return null;
  return title.length > MAX_TITLE_LENGTH
    ? title.slice(0, MAX_TITLE_LENGTH)
    : title;
}
