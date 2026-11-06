import { afterEach, expect, test, vi } from "vitest";
import { setTeamConfig } from "@loreai/core";
import {
  accountDataClient,
  clearSession,
  persistSession,
} from "../src/supabase";

const RealHeaders = globalThis.Headers;
const saved = {
  user_id: "fixture-user",
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

test.each(
  (["profile", "provision"] as const).flatMap((kind) =>
    (["logout", "switch", "relogin", "unchanged", "rotation"] as const).map(
      (transition) => [kind, transition] as const,
    ),
  ),
)("%s fences %s after the SDK resolves its token", async (kind, transition) => {
  const revision = persistSession(saved);
  const requests: { path: string; authorization: string | null }[] = [];
  const boundary = { armed: false, reached: false };
  // The real SDK awaits its token, then sets Authorization before invoking
  // its configured transport. Interleave at that exact synchronous boundary.
  vi.stubGlobal(
    "Headers",
    class extends RealHeaders {
      override set(name: string, value: string): void {
        super.set(name, value);
        if (
          !boundary.armed ||
          name.toLowerCase() !== "authorization" ||
          value !== "Bearer fixture-access"
        )
          return;
        boundary.armed = false;
        boundary.reached = true;
        if (transition === "logout") clearSession();
        if (transition === "switch")
          persistSession({
            ...saved,
            user_id: "other-user",
            access_token: "other-access",
          });
        if (transition === "relogin") persistSession(saved);
        if (transition === "rotation")
          setTeamConfig(
            "supabase.session",
            JSON.stringify({ ...saved, access_token: "rotated-access" }),
          );
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(input instanceof Request ? input.url : String(input))
          .pathname,
        authorization: new RealHeaders(init?.headers).get("authorization"),
      });
      return Response.json(
        kind === "profile" ? { display_name: "Fixture" } : { teams: 1 },
      );
    },
  );
  const client = accountDataClient(revision, saved);
  boundary.armed = true;
  if (kind === "profile")
    await client
      .from("profiles")
      .select("display_name")
      .eq("id", saved.user_id)
      .maybeSingle()
      .retry(false);
  else
    await client.functions.invoke("github-provision", {
      body: { provider_token: "fixture-provider" },
    });
  expect(boundary.reached, transition).toBe(true);
  if (transition === "unchanged" || transition === "rotation") {
    expect(requests, transition).toEqual([
      {
        path:
          kind === "profile"
            ? "/rest/v1/profiles"
            : "/functions/v1/github-provision",
        authorization: `Bearer ${transition === "rotation" ? "rotated-access" : "fixture-access"}`,
      },
    ]);
  } else expect(requests, transition).toEqual([]);
  vi.unstubAllGlobals();
});
