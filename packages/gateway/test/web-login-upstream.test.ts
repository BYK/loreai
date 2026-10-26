import { expect, test, vi } from "vitest";
import { clearSession, createSupabaseClient } from "../src/supabase";
import { handleWebLoginRequest } from "../src/web-login";
import { loadConfig } from "../src/config";
import { provisionGitHubTeams } from "../src/cli/login";

test("the real auth SDK holds a failed response until its original body is cancelled", async () => {
  let release: (() => void) | undefined;
  const cancel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const fetch = vi.fn(
    async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const client = createSupabaseClient(() => controller.signal);
  let settled = false;
  const operation = client.auth
    .signInWithOtp({ email: "person@example.com" })
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), {
      timeout: 500,
    });
    expect(settled).toBe(false);
    release?.();
    expect((await operation).error).toBeTruthy();
  } finally {
    controller.abort();
    release?.();
    await operation;
    vi.unstubAllGlobals();
  }
});

test("failed upstream bodies retain all login operation slots until cancellation settles", async () => {
  const releases: Array<() => void> = [];
  const cancel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  );
  const fetch = vi.fn(
    async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  const config = { ...loadConfig(), hostedMode: false, remoteGateway: false };
  const pending: Array<Promise<Response | null>> = [];
  const start = () => {
    const url = new URL("http://127.0.0.1:1234/api/v1/account/login/email");
    return handleWebLoginRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
      url,
      config,
    );
  };
  try {
    for (let i = 0; i < 16; i++) {
      pending.push(start());
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(i + 1));
    }
    expect((await start())?.status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(16);
  } finally {
    for (const release of releases) release();
    await Promise.all(pending);
    vi.unstubAllGlobals();
  }
});

test.each([
  ["http error", 403, {}],
  ["rate limit", 429, {}],
  ["relay error", 200, { "x-relay-error": "true" }],
  ["event stream", 200, { "content-type": "text/event-stream" }],
])(
  "provisioning retains a %s response until its body cancellation settles",
  async (_name, status, headers) => {
    let release: (() => void) | undefined;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), { status, headers }),
      ),
    );
    const controller = new AbortController();
    const client = createSupabaseClient(() => controller.signal);
    let settled = false;
    const operation = provisionGitHubTeams(
      client,
      "fake-provider-token",
      true,
    ).then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), {
        timeout: 500,
      });
      expect(settled).toBe(false);
      release?.();
      await operation;
    } finally {
      controller.abort();
      release?.();
      await operation;
      vi.unstubAllGlobals();
    }
  },
);

test("CLI provisioning does not wait for a stalled response cancellation", async () => {
  let release: (() => void) | undefined;
  const cancel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status: 403 }),
    ),
  );
  const client = createSupabaseClient();
  try {
    await provisionGitHubTeams(client, "fake-provider-token");
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    release?.();
    vi.unstubAllGlobals();
  }
});

test("real Functions errors retain web login optional slots until cancellation settles", async () => {
  const releases: Array<() => void> = [];
  const cancel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  );
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname.endsWith("/token"))
      return Response.json({
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expires_in: 3600,
        token_type: "bearer",
        provider_token: "fake-provider-token",
        user: {
          id: "fake-user",
          email: "person@example.com",
          user_metadata: {},
        },
      });
    if (url.pathname.endsWith("/github-provision"))
      return new Response(new ReadableStream({ cancel }), { status: 403 });
    if (url.pathname.endsWith("/profiles")) return Response.json(null);
    throw new Error("Unexpected test endpoint");
  });
  vi.stubGlobal("fetch", fetch);
  const config = { ...loadConfig(), hostedMode: false, remoteGateway: false };
  try {
    for (let i = 0; i < 17; i++) {
      clearSession();
      const startUrl = new URL(
        "http://127.0.0.1:1234/api/v1/account/login/github",
      );
      const started = await handleWebLoginRequest(
        new Request(startUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        startUrl,
        config,
      );
      expect(started?.status).toBe(200);
      const { attempt } = await started!.json();
      const callback = new URL(
        `http://127.0.0.1:1234/api/v1/account/login/callback?attempt=${attempt}&code=fake`,
      );
      expect(
        (
          await handleWebLoginRequest(new Request(callback), callback, config)
        )?.headers.get("location"),
      ).toBe(`/ui?login=success&login_attempt=${attempt}`);
      if (i < 16)
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(i + 1));
    }
    expect(cancel).toHaveBeenCalledTimes(16);
  } finally {
    for (const release of releases) release();
    clearSession();
    vi.unstubAllGlobals();
  }
});
