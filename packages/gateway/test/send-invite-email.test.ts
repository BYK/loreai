/**
 * Unit tests for the send-invite-email Edge Function's pure core (E-5-e, #630/#827) — invite email
 * body construction + SMTP2GO HTTP send. Mirrors github-discover.test.ts: imports the Deno-free
 * `send.ts` and drives sendViaSmtp2go with a fetch mock.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildInviteEmail,
  capabilityOf,
  sendViaSmtp2go,
} from "../../../supabase/functions/send-invite-email/send";

describe("capabilityOf", () => {
  it("returns a capability-only token unchanged", () => {
    expect(capabilityOf("abc123")).toBe("abc123");
  });
  it("strips the ephemeral secret suffix (offline invite) — DB stores only the capability", () => {
    expect(capabilityOf("cap.SECRETb64url")).toBe("cap");
    // only the FIRST dot delimits — the secret itself may contain no dots but be defensive.
    expect(capabilityOf("cap.a.b")).toBe("cap");
  });
});

describe("buildInviteEmail", () => {
  it("includes the accept command, team name, role, and expiry", () => {
    const m = buildInviteEmail({
      token: "tok123",
      teamName: "Acme",
      role: "editor",
    });
    expect(m.subject).toContain("Acme");
    expect(m.text).toContain("lore team accept tok123");
    expect(m.text).toContain("as editor");
    expect(m.text).toContain("14 days");
    expect(m.html).toContain("lore team accept tok123");
  });

  it("defaults role to editor and team name when absent", () => {
    const m = buildInviteEmail({ token: "t" });
    expect(m.text).toContain("as editor");
    expect(m.subject).toContain("a Lore team");
  });

  it("maps an unknown role to editor (never leaks a bogus role)", () => {
    const m = buildInviteEmail({ token: "t", role: "admin" });
    expect(m.text).toContain("as editor");
  });

  it("adds the one-time-key warning ONLY for offline invites", () => {
    const online = buildInviteEmail({ token: "t", offline: false });
    const offline = buildInviteEmail({ token: "t", offline: true });
    expect(online.text).not.toContain("one-time key");
    expect(offline.text).toContain("one-time key");
    expect(offline.html).toContain("one-time key");
  });

  it("escapes HTML in the team name (no injection into the html body)", () => {
    const m = buildInviteEmail({ token: "t", teamName: "<script>x</script>" });
    expect(m.html).not.toContain("<script>x</script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});

describe("sendViaSmtp2go", () => {
  const email = { subject: "s", text: "t", html: "<p>h</p>" };
  const opts = (fetchImpl: typeof fetch) => ({
    apiKey: "KEY",
    sender: "keeper@withlore.ai",
    fetchImpl,
  });

  it("POSTs to the SMTP2GO API with the key header and recipient, and resolves on success", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { succeeded: 1, failed: 0 } }),
      } as Response;
    }) as unknown as typeof fetch;
    await sendViaSmtp2go("a@b.com", email, opts(f));
    expect(calls[0].url).toContain("api.smtp2go.com");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Smtp2go-Api-Key"]).toBe("KEY");
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.to).toEqual(["a@b.com"]);
    expect(sent.sender).toBe("keeper@withlore.ai");
    expect(sent.subject).toBe("s");
  });

  it("throws on a non-ok HTTP status", async () => {
    const f = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;
    await expect(sendViaSmtp2go("a@b.com", email, opts(f))).rejects.toThrow(
      /smtp2go: 500/,
    );
  });

  it("throws when SMTP2GO reports an API-level error on a 200", async () => {
    const f = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ data: { error: "bad api key" } }),
      }) as Response) as unknown as typeof fetch;
    await expect(sendViaSmtp2go("a@b.com", email, opts(f))).rejects.toThrow(
      /bad api key/,
    );
  });

  it("throws when no recipient was accepted (succeeded < 1)", async () => {
    const f = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ data: { succeeded: 0, failed: 1 } }),
      }) as Response) as unknown as typeof fetch;
    await expect(sendViaSmtp2go("a@b.com", email, opts(f))).rejects.toThrow(
      /no recipients accepted/,
    );
  });
});
