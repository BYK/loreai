/**
 * Unit coverage for sendInviteEmail (E-5-e, #630/#827) — gateway caller that hands off to the
 * `send-invite-email` Edge Function. Mirrors the structure of team.test.ts (mocks
 * SupabaseClient.functions.invoke and exercises each branch), but scopes tightly to the new
 * resolution logic so we hit the 4 branches the codecov patch flagged as uncovered.
 */
import { describe, expect, it, vi } from "vitest";

// Mock supabase for currentUser + log-only consumer. sendInviteEmail does not touch session.
vi.mock("../src/supabase", () => ({
  getCurrentUser: () => Promise.resolve({ user_id: "u1" }),
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendInviteEmail } from "../src/team";

interface InvokeCall {
  function: string;
  body: Record<string, unknown>;
}

function makeClient(invoker: (body: Record<string, unknown>) => unknown) {
  const calls: InvokeCall[] = [];
  return {
    calls,
    functions: {
      invoke(name: string, opts: { body: Record<string, unknown> }) {
        calls.push({ function: name, body: opts.body });
        return Promise.resolve(invoker(opts.body));
      },
    },
  } as unknown as SupabaseClient & { calls: InvokeCall[] };
}

describe("sendInviteEmail (E-5-e)", () => {
  it("sends the hint as a real email when it passes the email regex", async () => {
    const client = makeClient((_body) => ({
      data: { resolved_via: "explicit_email" },
      error: null,
    }));
    const result = await sendInviteEmail(client, "tok-abcd", "ada@example.com");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      function: "send-invite-email",
      body: { token: "tok-abcd", email: "ada@example.com" },
    });
    expect(result).toEqual({ ok: true, resolvedVia: "explicit_email" });
  });

  it("resolves via a github login: passes github_login + provider_token to the EF", async () => {
    const client = makeClient((_body) => ({
      data: { resolved_via: "lore_email" },
      error: null,
    }));
    const result = await sendInviteEmail(client, "tok-abcd", "octocat", {
      providerToken: "gho_x",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      function: "send-invite-email",
      body: {
        token: "tok-abcd",
        github_login: "octocat",
        provider_token: "gho_x",
      },
    });
    expect(result).toEqual({ ok: true, resolvedVia: "lore_email" });
  });

  it("resolves via a github login WITHOUT a providerToken: EF body omits provider_token", async () => {
    // The EF will return no_resolvable_email; we surface that as { ok: false } so the CLI falls
    // back to printing the link. The gateway never persists the oauth token for this case.
    const client = makeClient((_body) => ({
      data: { error: "no_resolvable_email" },
      error: { message: "no_resolvable_email" },
    }));
    const result = await sendInviteEmail(client, "tok-abcd", "octocat");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].body).not.toHaveProperty("provider_token");
    expect(client.calls[0].body).toEqual({
      token: "tok-abcd",
      github_login: "octocat",
    });
    expect(result).toEqual({ ok: false, resolvedVia: null });
  });

  it("returns { ok: true, resolvedVia: null } when the EF omits resolved_via", async () => {
    // Defensive path: a future EF version might forget the field. The CLI still surfaces \"emailed\".
    const client = makeClient(() => ({ data: null, error: null }));
    const result = await sendInviteEmail(client, "tok-abcd", "ada@example.com");
    expect(result).toEqual({ ok: true, resolvedVia: null });
  });

  it("returns { ok: false, resolvedVia: null } when the EF errors", async () => {
    const client = makeClient(() => ({
      data: null,
      error: { message: "smtp2go: 502" },
    }));
    const result = await sendInviteEmail(client, "tok-abcd", "ada@example.com");
    expect(result).toEqual({ ok: false, resolvedVia: null });
  });

  it("returns { ok: false, resolvedVia: null } when the invoke itself throws (network)", async () => {
    const client = {
      functions: {
        invoke: () => Promise.reject(new Error("network blip")),
      },
    } as unknown as SupabaseClient;
    const result = await sendInviteEmail(client, "tok-abcd", "ada@example.com");
    expect(result).toEqual({ ok: false, resolvedVia: null });
  });

  it("ignores providerToken when the hint is a real email (email path takes precedence)", async () => {
    // Belt-and-suspenders: even if the caller passes a providerToken for an email hint, the email
    // path wins. Makes future-shape refactors obvious in tests.
    const client = makeClient((_body) => ({
      data: { resolved_via: "explicit_email" },
      error: null,
    }));
    await sendInviteEmail(client, "tok-abcd", "ada@example.com", {
      providerToken: "gho_x",
    });
    expect(client.calls[0].body).not.toHaveProperty("github_login");
    expect(client.calls[0].body).not.toHaveProperty("provider_token");
  });
});
