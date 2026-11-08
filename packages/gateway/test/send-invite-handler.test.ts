import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test, vi } from "vitest";

const privateDiagnostic = "private-invite-sentinel\u001b[2J";
const capability = "a".repeat(64);
const offlineSecret = Buffer.alloc(32, 7).toString("base64url");
const bundle = { code: "" };
const entry = fileURLToPath(
  new URL(
    "../../../supabase/functions/send-invite-email/index.ts",
    import.meta.url,
  ),
);

beforeAll(async () => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["npm:@supabase/supabase-js@2", "@sentry/deno"],
  });
  bundle.code = result.outputFiles[0].text;
});

type Failure =
  | "email-rpc"
  | "invite-read"
  | "smtp-transport"
  | "smtp-body"
  | "none";

function harness(failure: Failure) {
  const consoleOutput: unknown[][] = [];
  const telemetry: unknown[] = [];
  const tags: unknown[][] = [];
  const output = (...values: unknown[]) => consoleOutput.push(values);
  const env: Record<string, string> = {
    SUPABASE_URL: "https://account.example.test",
    SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    SMTP2GO_API_KEY: "fixture-smtp-key",
    SMTP2GO_API_URL: "https://smtp.example.test/send",
    GITHUB_API_URL: "https://github.example.test",
  };
  const owner = "fixture-invite-owner";
  const scope = "00000000-0000-4000-8000-000000000001";
  const getUser = vi.fn(async () => ({
    data: { user: { id: owner } },
    error: null,
  }));
  const scopeRole = vi.fn(async () => ({ data: "admin", error: null }));
  const emailLookup = vi.fn(async () => ({
    data:
      failure === "email-rpc"
        ? null
        : [{ github_id: 999, email: "member@example.test" }],
    error: failure === "email-rpc" ? { message: privateDiagnostic } : null,
  }));
  const invite = {
    scope_id: scope,
    role: "viewer",
    invited_by: owner,
    eph_pub: "fixture-ephemeral-key",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  const inviteRead = vi.fn(async () => ({
    data: failure === "invite-read" ? null : invite,
    error: failure === "invite-read" ? { message: privateDiagnostic } : null,
  }));
  const inviteFilter = vi.fn(() => ({ maybeSingle: inviteRead }));
  const admin = {
    rpc: emailLookup,
    from: (table: string) => ({
      select: () => ({
        eq:
          table === "pending_invites"
            ? inviteFilter
            : () => ({
                maybeSingle: async () => ({
                  data: { name: "Fixture team" },
                  error: null,
                }),
              }),
      }),
    }),
  };
  const smtp = vi.fn(async (_url: string, _init: RequestInit) => {
    if (failure === "smtp-transport") throw new Error(privateDiagnostic);
    return Response.json({
      data:
        failure === "smtp-body"
          ? { error: privateDiagnostic }
          : { succeeded: 1 },
    });
  });
  const handlers: Array<(request: Request) => Promise<Response>> = [];
  runInNewContext(bundle.code, {
    require: (id: string) => {
      if (id === "npm:@supabase/supabase-js@2") {
        return {
          createClient: (_url: string, key: string) =>
            key === "fixture-service"
              ? admin
              : { auth: { getUser }, rpc: scopeRole },
        };
      }
      if (id === "@sentry/deno") {
        return {
          init: vi.fn(),
          setTag: vi.fn(),
          isInitialized: () => true,
          withScope: (
            run: (scope: { setTag: (...values: unknown[]) => void }) => void,
          ) =>
            run({
              setTag: (...values) => {
                tags.push(values);
              },
            }),
          captureException: (error: Error) =>
            telemetry.push({ message: error.message, stack: error.stack }),
          flush: async () => true,
        };
      }
      throw new Error("Unexpected invitation handler dependency");
    },
    Deno: {
      env: { get: (key: string) => env[key] },
      serve: (handler: (request: Request) => Promise<Response>) =>
        handlers.push(handler),
    },
    Request,
    Response,
    Headers,
    URL,
    console: {
      log: output,
      warn: output,
      error: output,
      debug: output,
      info: output,
    },
    fetch: (url: string, init: RequestInit) => {
      if (url === "https://github.example.test/users/fixture-member")
        return Promise.resolve(
          Response.json({ id: 999, email: "public-member@example.test" }),
        );
      if (url === "https://smtp.example.test/send") return smtp(url, init);
      throw new Error("Unexpected invitation fixture request");
    },
  });
  return {
    consoleOutput,
    telemetry,
    tags,
    getUser,
    emailLookup,
    inviteRead,
    inviteFilter,
    scopeRole,
    smtp,
    request: () =>
      handlers[0](
        new Request(
          "https://account.example.test/functions/v1/send-invite-email",
          {
            method: "POST",
            headers: {
              authorization: "Bearer fixture-session",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              token: `${capability}.${offlineSecret}`,
              github_login: "fixture-member",
              provider_token: "fixture-provider-token",
            }),
          },
        ),
      ),
  };
}

test.each([
  ["email-rpc", 200, "send-invite-email.lookup-lore-email"],
  ["invite-read", 500, "send-invite-email.lookup-invite"],
  ["smtp-transport", 502, "send-invite-email.send-smtp"],
  ["smtp-body", 502, "send-invite-email.send-smtp"],
  ["none", 200, null],
] as const)(
  "invitation handler keeps %s diagnostics private",
  async (failure, status, site) => {
    const h = harness(failure);
    const response = await h.request();
    expect(response.status).toBe(status);
    const body = await response.text();
    for (const surface of [
      body,
      JSON.stringify(h.consoleOutput),
      JSON.stringify(h.telemetry),
    ]) {
      expect(surface).not.toContain("private-invite-sentinel");
      expect(surface).not.toContain("\u001b[2J");
      expect(surface).not.toContain("\\u001b");
      expect(surface).not.toContain("fixture-provider-token");
      expect(surface).not.toContain(offlineSecret);
      expect(surface).not.toContain("member@example.test");
    }
    expect(h.getUser).toHaveBeenCalledOnce();
    expect(h.inviteFilter).toHaveBeenCalledExactlyOnceWith("token", capability);
    if (site) {
      expect(h.telemetry).toHaveLength(1);
      expect(h.tags).toContainEqual(["failure_site", site]);
    } else {
      expect(h.telemetry).toEqual([]);
    }
    if (failure === "invite-read") {
      expect(h.emailLookup).not.toHaveBeenCalled();
      expect(h.scopeRole).not.toHaveBeenCalled();
      expect(h.smtp).not.toHaveBeenCalled();
    } else {
      expect(h.emailLookup).toHaveBeenCalledExactlyOnceWith(
        "lore_emails_for_github_ids",
        { p_github_ids: [999] },
      );
      expect(h.scopeRole).toHaveBeenCalledExactlyOnceWith("scope_role", {
        p_scope: "00000000-0000-4000-8000-000000000001",
      });
      expect(h.smtp).toHaveBeenCalledOnce();
    }
    if (status === 200) {
      expect(JSON.parse(body)).toEqual({
        ok: true,
        resolved_via:
          failure === "email-rpc" ? "github_public_email" : "lore_email",
      });
      const mail = JSON.parse(h.smtp.mock.calls[0][1].body as string);
      expect(mail.to).toEqual([
        failure === "email-rpc"
          ? "public-member@example.test"
          : "member@example.test",
      ]);
      expect(mail.text_body).toContain(`${capability}.${offlineSecret}`);
    }
  },
);
