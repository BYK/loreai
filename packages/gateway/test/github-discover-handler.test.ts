import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test, vi } from "vitest";

const privateDiagnostic = "private-discover-sentinel\u001b[2J";
const bundle = { code: "" };
beforeAll(async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../../../supabase/functions/github-discover/index.ts",
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["npm:@supabase/supabase-js@2", "@sentry/deno"],
  });
  bundle.code = result.outputFiles[0].text;
});

test.each([
  "identity",
  "repositories",
  "contributors",
  "lookup",
  "none",
] as const)(
  "discovery keeps %s failures private through its real Edge handler",
  async (failure) => {
    const diagnostics: string[] = [];
    const telemetry: string[] = [];
    const output = (...values: unknown[]) => {
      diagnostics.push(...values.map(String));
    };
    const capture = (...values: unknown[]) => {
      telemetry.push(...values.map(String));
    };
    const rpc = vi.fn(async () => ({
      data: [{ github_id: 123 }],
      error: failure === "lookup" ? { message: privateDiagnostic } : null,
    }));
    const handlers: Array<(request: Request) => Promise<Response>> = [];
    runInNewContext(bundle.code, {
      require: (name: string) => {
        if (name === "npm:@supabase/supabase-js@2")
          return {
            createClient: () => ({
              rpc,
              auth: {
                getUser: async () => ({
                  data: {
                    user: {
                      id: "fixture-user",
                      identities: [{ provider: "github", id: "999" }],
                    },
                  },
                  error: null,
                }),
              },
            }),
          };
        if (name === "@sentry/deno")
          return {
            init: vi.fn(),
            setTag: capture,
            isInitialized: () => true,
            withScope: (run: (scope: { setTag: typeof capture }) => void) =>
              run({ setTag: capture }),
            captureException: (error: Error) =>
              capture(error.message, error.stack),
            flush: async () => true,
          };
        throw new Error("Unexpected Edge fixture dependency");
      },
      Deno: {
        env: {
          get: (key: string) =>
            (
              ({
                SUPABASE_URL: "https://account.example.test",
                SUPABASE_ANON_KEY: "fixture-anon",
                SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
                GITHUB_API_URL: "https://github.example.test",
              }) as Record<string, string>
            )[key],
        },
        serve: (handler: (request: Request) => Promise<Response>) =>
          handlers.push(handler),
      },
      Request,
      Response,
      Headers,
      URL,
      console: {
        log: output,
        error: output,
        warn: output,
        debug: output,
        info: output,
      },
      fetch: async (url: string) => {
        const path = new URL(url).pathname;
        if (
          (failure === "identity" && path === "/user") ||
          (failure === "repositories" && path === "/user/repos") ||
          (failure === "contributors" && path.endsWith("/contributors"))
        )
          throw new Error(privateDiagnostic);
        if (path === "/user")
          return Response.json({ id: 999, login: "fixture-owner" });
        if (path === "/user/repos")
          return Response.json([{ full_name: "fixture-owner/private-repo" }]);
        if (path.endsWith("/contributors"))
          return Response.json([{ id: 123, login: "fixture-contributor" }]);
        throw new Error("Unexpected GitHub fixture request");
      },
    });
    const response = await handlers[0](
      new Request("https://account.example.test/functions/v1/github-discover", {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider_token: "fixture-provider" }),
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(
      failure === "identity" || failure === "repositories"
        ? 502
        : failure === "lookup"
          ? 500
          : 200,
    );
    for (const exported of [
      diagnostics.join("\n"),
      telemetry.join("\n"),
      body,
    ]) {
      expect(exported).not.toContain("private-discover-sentinel");
      expect(exported).not.toContain("\u001b[2J");
    }
    for (const exported of [diagnostics.join("\n"), telemetry.join("\n")]) {
      for (const privateValue of [
        "fixture-session",
        "fixture-provider",
        "fixture-user",
        "fixture-owner",
        "fixture-contributor",
        "private-repo",
      ])
        expect(exported).not.toContain(privateValue);
    }
    if (failure === "none") {
      expect(JSON.parse(body)).toMatchObject({
        repos: [
          {
            repo: "fixture-owner/private-repo",
            contributors: [{ login: "fixture-contributor", on_lore: true }],
          },
        ],
      });
      expect(rpc).toHaveBeenCalledExactlyOnceWith("lore_users_for_github_ids", {
        p_github_ids: [123],
      });
    }
  },
);
