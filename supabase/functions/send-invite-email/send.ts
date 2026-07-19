// E-5-e (#630/#827): pure, runtime-portable core of the send-invite-email Edge Function — build the
// invite email body and POST it to SMTP2GO's HTTP API. No Deno/npm imports here so it is
// unit-testable under Node/Vitest; index.ts is the thin Deno glue that adds JWT + service-role
// token-owner authorization.

export interface InviteEmailInput {
  token: string;
  teamName?: string | null;
  role?: string | null;
  /** Whether the token itself carries a one-time decryption key (offline/eph: invite). */
  offline?: boolean;
}
export interface InviteEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the invite email. An ONLINE invite carries no decryption-capable material (the admin wraps
 * the DEK to the new member on their next sync); an OFFLINE (eph:) invite's token is
 * decryption-capable by design, so the copy warns to treat it like a password and use a private
 * channel — same posture as the CLI printout today, just delivered by email.
 */
export function buildInviteEmail(input: InviteEmailInput): InviteEmail {
  const team = input.teamName?.trim() || "a Lore team";
  const role = input.role === "viewer" ? "viewer" : "editor";
  const accept = `lore team accept ${input.token}`;
  const subject = `You've been invited to ${team} on Lore`;
  const sensitiveLine = input.offline
    ? "\nThis invite carries a one-time key — treat it like a password and don't forward it.\n"
    : "";
  const text =
    `You've been invited to join ${team} on Lore as ${role}.\n\n` +
    `If you don't have Lore yet, install it from https://withlore.ai, sign in, then run:\n\n` +
    `  ${accept}\n${sensitiveLine}\n` +
    `This invite expires in 14 days.\n`;
  const sensitiveHtml = input.offline
    ? `<p style="color:#b45309">This invite carries a one-time key — treat it like a password and don't forward it.</p>`
    : "";
  const html =
    `<p>You've been invited to join <strong>${escapeHtml(team)}</strong> on Lore as ${role}.</p>` +
    `<p>If you don't have Lore yet, install it from <a href="https://withlore.ai">withlore.ai</a>, sign in, then run:</p>` +
    `<pre><code>${escapeHtml(accept)}</code></pre>` +
    sensitiveHtml +
    `<p>This invite expires in 14 days.</p>`;
  return { subject, text, html };
}

/**
 * Return the capability (DB-stored) portion of an invite token. An offline invite token is
 * `<capability>.<base64url(secret)>`; only the capability is stored in pending_invites.token, so a DB
 * lookup MUST use this (mirrors acceptTeamInvite). A capability-only token has no `.` and is returned
 * unchanged. The full token (with any secret suffix) is what the invitee needs and what we email.
 */
export function capabilityOf(token: string): string {
  const dot = token.indexOf(".");
  return dot >= 0 ? token.slice(0, dot) : token;
}

export interface Smtp2goOptions {
  apiKey: string;
  sender: string; // e.g. "keeper@withlore.ai"
  apiUrl?: string; // default https://api.smtp2go.com/v3/email/send
  fetchImpl?: typeof fetch;
}

/**
 * Send one email via SMTP2GO's HTTP API. Throws on a non-ok response or an API-level error field so
 * the caller can surface a generic failure (and still fall back to printing the invite link). The
 * API key is passed in the X-Smtp2go-Api-Key header and NEVER logged.
 */
export async function sendViaSmtp2go(
  to: string,
  email: InviteEmail,
  opts: Smtp2goOptions,
): Promise<void> {
  const apiUrl = (
    opts.apiUrl ?? "https://api.smtp2go.com/v3/email/send"
  ).replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const resp = await f(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Smtp2go-Api-Key": opts.apiKey,
    },
    body: JSON.stringify({
      sender: opts.sender,
      to: [to],
      subject: email.subject,
      text_body: email.text,
      html_body: email.html,
    }),
  });
  if (!resp.ok) throw new Error(`smtp2go: ${resp.status}`);
  // SMTP2GO returns 200 with a data.error / data.failures payload on partial failure.
  const body = (await resp.json().catch(() => ({}))) as {
    data?: { succeeded?: number; failed?: number; error?: string };
  };
  const d = body.data ?? {};
  if (d.error) throw new Error(`smtp2go: ${d.error}`);
  if (typeof d.succeeded === "number" && d.succeeded < 1)
    throw new Error("smtp2go: no recipients accepted");
}
