import { createClient } from "@supabase/supabase-js";
import { build } from "esbuild";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeAll, expect, test, vi } from "vitest";

const functions = [
  "github-provision",
  "github-discover",
  "send-invite-email",
] as const;
const bundles = new Map<string, string>();
const privateDiagnostic =
  "edge-private-sentinel fixture-transport-token person@example.test\u001b[2J";

beforeAll(async () => {
  await Promise.all(
    functions.map(async (name) => {
      const result = await build({
        entryPoints: [
          fileURLToPath(
            new URL(
              `../../../supabase/functions/${name}/index.ts`,
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
      bundles.set(name, result.outputFiles[0].text);
    }),
  );
});

test.each(functions)(
  "%s sanitizes rejected Auth transport before the real SDK can log it",
  async (name) => {
    const output: unknown[][] = [];
    const telemetry: unknown[] = [];
    const spies = (
      ["log", "info", "debug", "warn", "error", "trace"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        output.push(values);
      }),
    );
    const transport = vi.fn(async (): Promise<Response> => {
      throw new Error(privateDiagnostic);
    });
    vi.stubGlobal("fetch", transport);
    try {
      const handlers: Array<(request: Request) => Promise<Response>> = [];
      const env: Record<string, string> = {
        SUPABASE_URL: "https://account.example.test",
        SUPABASE_ANON_KEY: "fixture-anon",
        SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
        SMTP2GO_API_KEY: "fixture-smtp",
      };
      runInNewContext(bundles.get(name)!, {
        require: (id: string) => {
          // The installed SDK is intentionally real: mocked getUser() cannot expose
          // its console.error path when the underlying fetch rejects.
          if (id === "npm:@supabase/supabase-js@2") return { createClient };
          if (id === "@sentry/deno")
            return {
              init() {},
              setTag() {},
              isInitialized: () => true,
              withScope: (run: (scope: { setTag: () => void }) => void) =>
                run({ setTag() {} }),
              captureException: (error: Error) => {
                telemetry.push({ message: error.message, stack: error.stack });
              },
              flush: async () => true,
            };
          throw new Error("Unexpected Edge Auth dependency");
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
        console,
        fetch: transport,
      });
      const request = () =>
        handlers[0](
          new Request(`https://account.example.test/functions/v1/${name}`, {
            method: "POST",
            headers: {
              authorization: "Bearer fixture-session",
              "content-type": "application/json",
            },
            body: "{}",
          }),
        );
      const rejected = await request();
      expect(rejected.status).toBe(401);
      const responseBody = await rejected.text();
      expect(transport).toHaveBeenCalledOnce();
      for (const surface of [
        responseBody,
        inspect(output, { depth: 5 }),
        JSON.stringify(telemetry),
      ]) {
        expect(surface).not.toContain("edge-private-sentinel");
        expect(surface).not.toContain("fixture-transport-token");
        expect(surface).not.toContain("person@example.test");
        expect(surface).not.toContain("\u001b[2J");
      }

      // A successful Auth response still reaches each handler's own input validation.
      transport.mockImplementation(async () =>
        Response.json({ id: "fixture-user", identities: [] }),
      );
      const authorized = await request();
      expect(authorized.status).toBe(400);
      expect(await authorized.text()).not.toContain("invalid token");
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      for (const spy of spies) spy.mockRestore();
    }
  },
);
