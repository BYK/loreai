import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";

test.each([307, 308])(
  "web provisioning never forwards its provider token on a %s redirect",
  async (status) => {
    let forwarded = 0;
    const target = createServer((_req, res) => {
      forwarded++;
      res.end();
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const location = `http://127.0.0.1:${(target.address() as AddressInfo).port}/target`;
    let received = 0;
    const upstream = createServer((_req, res) => {
      received++;
      res.writeHead(status, { location }).end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    vi.stubEnv(
      "SUPABASE_URL",
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    );
    vi.stubEnv("SUPABASE_ANON_KEY", "fake-key");
    vi.resetModules();
    try {
      const { createSupabaseClient } = await import("../src/supabase");
      const { provisionGitHubTeams } = await import("../src/cli/login");
      const controller = new AbortController();
      await provisionGitHubTeams(
        createSupabaseClient(() => controller.signal),
        "fake-provider-token",
        true,
      );
      expect(received).toBe(1);
      expect(forwarded).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      upstream.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => upstream.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  },
);
