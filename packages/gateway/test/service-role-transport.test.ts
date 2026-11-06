import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  process.exitCode = 0;
});

test.each(
  [307, 308].flatMap((status) =>
    ["GET", "PATCH"].map((method) => [status, method] as const),
  ),
)(
  "service-role %s %s never forwards credentials across origins",
  async (status, method) => {
    const received: string[] = [];
    const upstreamRequests: string[] = [];
    const target = createServer((req, res) => {
      received.push(String(req.headers.apikey));
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const upstream = createServer((req, res) => {
      upstreamRequests.push(req.method ?? "");
      req.resume();
      res
        .writeHead(status, {
          location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/target`,
        })
        .end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    vi.stubEnv(
      "SUPABASE_URL",
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    );
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-role");
    vi.resetModules();
    try {
      const { getServiceRoleClient } = await import("../src/supabase");
      const client = getServiceRoleClient()!;
      const result =
        method === "GET"
          ? await client.from("profiles").select("id").retry(false)
          : await client
              .from("profiles")
              .update({ tier: "pro" })
              .eq("id", "fixture-user")
              .select("id")
              .retry(false);
      expect(upstreamRequests).toEqual([method]);
      expect(received).toEqual([]);
      expect(result.error).not.toBeNull();
    } finally {
      upstream.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => upstream.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  },
);

test("service-role factory reads its key at call time and permits a successful authorized request", async () => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.resetModules();
  const { getServiceRoleClient } = await import("../src/supabase");
  expect(getServiceRoleClient()).toBeNull();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-role");
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("apikey")).toBe(
      "fixture-service-role",
    );
    return Response.json([{ id: "fixture-user" }]);
  });
  vi.stubGlobal("fetch", fetch);
  const { data, error } = await getServiceRoleClient()!
    .from("profiles")
    .select("id");
  expect(error).toBeNull();
  expect(data).toEqual([{ id: "fixture-user" }]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(["transport", "provider"])(
  "operator command never prints %s diagnostics",
  async (mode) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-role");
    vi.resetModules();
    const fetch = vi.fn(async () => {
      if (mode === "transport")
        throw new Error(
          "private-service-role-sentinel\u001b[2J fixture-service-role",
        );
      return Response.json(
        {
          message:
            "private-service-role-sentinel\u001b[2J fixture-service-role",
        },
        { status: 400 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const { commandAdmin } = await import("../src/cli/admin-cmd");
    await commandAdmin(
      ["grant", "00000000-0000-4000-8000-000000000001", "team"],
      {},
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    const rendered = output.mock.calls.flat().join("\n");
    expect(rendered).not.toContain("private-service-role-sentinel");
    expect(rendered).not.toContain("fixture-service-role");
    expect(rendered).not.toContain("\u001b");
    expect(output).toHaveBeenCalledWith(
      "lore admin: Account service unavailable. Please try again.",
    );
  },
);
