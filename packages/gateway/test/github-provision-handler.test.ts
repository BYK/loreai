import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

const privateDiagnostic = "private-provision-sentinel\u001b[2J";
const entry = fileURLToPath(
  new URL(
    "../../../supabase/functions/github-provision/index.ts",
    import.meta.url,
  ),
);
const bundle = { code: "" };

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

function harness(
  options: {
    identities?: Array<{ provider: string; id: string }>;
    metadataId?: unknown;
    rpcFailure?: boolean;
    transportFailure?: boolean;
  } = {},
) {
  const rpc = vi.fn(async () => ({
    error: options.rpcFailure ? { message: privateDiagnostic } : null,
  }));
  const diagnostics: string[] = [];
  const output = vi.fn((...values: unknown[]) => {
    diagnostics.push(...values.map(String));
  });
  const handlers: Array<(request: Request) => Promise<Response>> = [];
  const createClient = vi.fn((_url: string, key: string) =>
    key === "fixture-service"
      ? { rpc }
      : {
          auth: {
            getUser: async () => ({
              data: {
                user: {
                  id: "lore-user",
                  identities: options.identities ?? [
                    { provider: "github", id: "999" },
                  ],
                  user_metadata: { provider_id: options.metadataId },
                },
              },
              error: null,
            }),
          },
        },
  );
  const sentry = {
    init: vi.fn(),
    setTag: vi.fn(),
    isInitialized: () => true,
    withScope: (run: (scope: { setTag: ReturnType<typeof vi.fn> }) => void) =>
      run({ setTag: vi.fn() }),
    captureException: (error: Error) =>
      diagnostics.push(error.message, error.stack ?? ""),
    flush: async () => true,
  };
  const env: Record<string, string> = {
    SUPABASE_URL: "https://account.example.test",
    SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GITHUB_API_URL: "https://github.example.test",
  };
  runInNewContext(bundle.code, {
    require: (id: string) => {
      if (id === "npm:@supabase/supabase-js@2") return { createClient };
      if (id === "@sentry/deno") return sentry;
      throw new Error("Unexpected Edge Function dependency");
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
    fetch: async (url: string) => {
      if (options.transportFailure) throw new Error(privateDiagnostic);
      const path = new URL(url).pathname;
      if (path === "/user")
        return Response.json({ id: 999, login: "fixture-owner" });
      if (path === "/user/memberships/orgs")
        return Response.json([
          {
            state: "active",
            role: "member",
            organization: { id: 1, login: "fixture-org" },
          },
        ]);
      if (path === "/user/teams")
        return Response.json([
          {
            id: 2,
            slug: "fixture-team",
            name: "Fixture team",
            organization: { id: 1 },
          },
        ]);
      throw new Error("Unexpected GitHub fixture request");
    },
  });
  return {
    rpc,
    diagnostics,
    request: () =>
      handlers[0](
        new Request(
          "https://account.example.test/functions/v1/github-provision",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer fixture-session",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              provider_token: "fixture-foreign-provider-token",
            }),
          },
        ),
      ),
  };
}

describe("github-provision handler identity and diagnostic boundaries", () => {
  it.each([
    { identities: [], metadataId: "999" },
    { identities: [], metadataId: 999 },
    { identities: [{ provider: "google", id: "999" }], metadataId: "999" },
  ])(
    "rejects a foreign token matching only editable metadata: %j",
    async (options) => {
      const h = harness(options);
      expect((await h.request()).status).toBe(403);
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );

  it("provisions a genuine linked GitHub identity despite unrelated editable metadata", async () => {
    const h = harness({ metadataId: "other-account" });
    expect((await h.request()).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("provision_github_membership", {
      p_user: "lore-user",
      p_orgs: [{ github_org_id: 1, login: "fixture-org", role: "member" }],
      p_teams: [
        {
          github_team_id: 2,
          github_org_id: 1,
          slug: "fixture-team",
          name: "Fixture team",
          role: "editor",
        },
      ],
    });
  });

  it.each(["rpc", "transport"] as const)(
    "keeps %s diagnostics out of logs, responses and telemetry",
    async (failure) => {
      const h = harness({
        rpcFailure: failure === "rpc",
        transportFailure: failure === "transport",
      });
      const response = await h.request();
      expect(response.status).toBe(failure === "rpc" ? 500 : 502);
      const exported = [...h.diagnostics, await response.text()].join("\n");
      expect(exported).not.toContain("private-provision-sentinel");
      expect(exported).not.toContain("\u001b[2J");
    },
  );
});
