import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import { installFetchInterceptor } from "../src/fetch-interceptor";
import { digestChain } from "../src/chain-digest";
import { encodeContextBoundary } from "../src/context-boundary";

const gateway = "https://gateway.example/lore";
const url = `${gateway}/v1/messages`;
const prefix = [{ role: "user", content: "original" }];
const appended = [...prefix, { role: "user", content: "next" }];
const headers = { "x-lore-session-id": "direct-session" };
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function boundary(items: unknown[]) {
  return encodeContextBoundary({
    v: 1,
    protocol: "anthropic",
    inputItems: items.length,
    inputDigest: digestChain(items),
    retainedItems: 0,
    sourceMessages: items.length,
    sourceDigest: digestChain([]),
  });
}

function install() {
  const getHeaders = vi.fn(() => ({ authorization: "must-not-be-injected" }));
  cleanup = installFetchInterceptor({ gatewayBase: gateway, getHeaders });
  return getHeaders;
}

function requestURL(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

async function send(items: unknown[], extra: RequestInit = {}) {
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude", messages: items }),
    ...extra,
  });
}

test("preserves direct routing, credentials and fetch options on suffix and replay", async () => {
  const calls: RequestInit[] = [];
  const token = boundary(prefix);
  const original = vi.fn<typeof fetch>(async (_input, init) => {
    calls.push(init!);
    return calls.length === 2
      ? new Response("mismatch", {
          status: 409,
          headers: { "x-lore-context-boundary-mismatch": "true" },
        })
      : new Response("ok", { headers: { "x-lore-context-boundary": token } });
  });
  globalThis.fetch = original;
  const getHeaders = install();
  const signal = new AbortController().signal;
  const credentials = {
    ...headers,
    authorization: "Bearer provider-secret",
    "x-api-key": "api-secret",
    "x-lore-gateway-token": "access-secret",
    "x-lore-provider": "custom",
    "x-lore-upstream-url": "https://provider.example/prefix",
    "x-lore-upstream-path": "/native?mode=1",
    "x-lore-project": "/private/project",
    "content-length": "999",
  };
  await (await send(prefix, { headers: credentials })).text();
  const body = JSON.stringify({ model: "claude", messages: appended });
  await (
    await send(appended, {
      headers: credentials,
      signal,
      redirect: "manual",
      credentials: "omit",
    })
  ).text();
  expect(getHeaders).not.toHaveBeenCalled();
  expect(calls).toHaveLength(3);
  for (const init of calls.slice(1)) {
    expect(init.signal).toBe(signal);
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    const forwarded = new Headers(init.headers);
    for (const [key, value] of Object.entries(credentials))
      if (key !== "content-length") expect(forwarded.get(key)).toBe(value);
  }
  expect(new Headers(calls[1].headers).get("content-length")).toBeNull();
  expect(new Headers(calls[1].headers).get("x-lore-context-boundary")).toBe(
    token,
  );
  expect(JSON.parse(calls[1].body as string).messages).toEqual(
    appended.slice(1),
  );
  expect(calls[2].body).toBe(body);
  expect(new Headers(calls[2].headers).get("content-length")).toBe("999");
  expect(
    new Headers(calls[2].headers).get("x-lore-context-boundary"),
  ).toBeNull();
  for (const [input] of original.mock.calls) expect(input).toBe(url);
});

test.each([
  [undefined, "manual"],
  ["follow", "manual"],
  ["error", "error"],
] as const)(
  "protects credentials on a stale-boundary replay with redirect %s",
  async (redirect, expected) => {
    const calls: RequestInit[] = [];
    const token = boundary(prefix);
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      calls.push(init!);
      return calls.length === 2
        ? new Response("mismatch", {
            status: 409,
            headers: { "x-lore-context-boundary-mismatch": "true" },
          })
        : new Response("ok", { headers: { "x-lore-context-boundary": token } });
    });
    install();
    const credentials = {
      ...headers,
      "x-api-key": "synthetic-provider-key",
      "x-lore-gateway-token": "synthetic-gateway-token",
    };
    await (await send(prefix, { headers: credentials, redirect })).text();
    await (await send(appended, { headers: credentials, redirect })).text();

    expect(calls).toHaveLength(3);
    expect(calls.map((init) => init.redirect)).toEqual([
      expected,
      expected,
      expected,
    ]);
    expect(
      new Headers(calls[2].headers).get("x-lore-context-boundary"),
    ).toBeNull();
    expect(JSON.parse(calls[2].body as string).messages).toEqual(appended);
  },
);

test.each([
  "/v1/responses/compact",
  "/v1/messages/count_tokens",
  "/v1/compact",
])("passes direct auxiliary requests through unchanged (%s)", async (path) => {
  const original = vi.fn<typeof fetch>(async () => new Response("ok"));
  globalThis.fetch = original;
  const getHeaders = install();
  const init = { method: "POST", headers, body: "opaque body" };
  await fetch(`${gateway}${path}`, init);
  expect(original).toHaveBeenCalledWith(`${gateway}${path}`, init);
  expect(original.mock.calls[0][1]).toBe(init);
  expect(getHeaders).not.toHaveBeenCalled();
});

test.each([
  "/v1/responses/compact",
  "/v1/messages/count_tokens",
  "/v1/compact",
])(
  "strips caller boundary claims from direct auxiliary requests (%s)",
  async (path) => {
    const original = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = original;
    const getHeaders = install();
    const init = {
      method: "POST",
      headers: {
        ...headers,
        "x-lore-context-boundary": "forged-boundary",
        "x-lore-context-boundary-capability": "v1",
      },
      body: "opaque body",
    };

    await fetch(`${gateway}${path}`, init);

    expect(requestURL(original.mock.calls[0][0])).toBe(`${gateway}${path}`);
    const forwarded = new Headers(original.mock.calls[0][1]?.headers);
    expect(forwarded.get("x-lore-context-boundary")).toBeNull();
    expect(forwarded.get("x-lore-context-boundary-capability")).toBeNull();
    expect(original.mock.calls[0][1]?.body).toBe("opaque body");
    expect(getHeaders).not.toHaveBeenCalled();
  },
);

test.each([
  "https://gateway.example.evil/lore/v1/messages",
  "https://gateway.example:444/lore/v1/messages",
  "https://gateway.example/lore-sibling/v1/messages",
])(
  "does not treat a URL string prefix as the configured gateway (%s)",
  async (target) => {
    const original = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = original;
    install();
    await fetch(target, { method: "POST", headers, body: "{}" });
    // These follow normal provider rewriting; none receive direct-gateway treatment.
    expect(original.mock.calls[0][0]).toBe(
      "https://gateway.example/v1/messages",
    );
    const forwarded = new Headers(original.mock.calls[0][1]?.headers);
    expect(forwarded.get("x-lore-upstream-url")).toBe(
      `${new URL(target).origin}${new URL(target).pathname.slice(0, -"/v1/messages".length)}`,
    );
  },
);

test("leaves a direct request without an explicit session complete", async () => {
  const original = vi.fn<typeof fetch>(
    async () =>
      new Response("ok", {
        headers: { "x-lore-context-boundary": boundary(prefix) },
      }),
  );
  globalThis.fetch = original;
  install();
  await (await send(prefix, { headers: {} })).text();
  await send(appended, { headers: {} });
  const init = original.mock.calls[1][1]!;
  expect(JSON.parse(init.body as string).messages).toEqual(appended);
  expect(
    new Headers(init.headers).get("x-lore-context-boundary-capability"),
  ).toBeNull();
});

test("keeps the validated destination when a header getter mutates its URL", async () => {
  const original = vi.fn<typeof fetch>(async () => new Response("ok"));
  globalThis.fetch = original;
  install();
  const destination = new URL(url);
  await fetch(destination, {
    method: "POST",
    get headers() {
      destination.href = "https://other-origin.example/v1/messages";
      return { ...headers, authorization: "Bearer original" };
    },
    body: JSON.stringify({ model: "claude", messages: prefix }),
  });
  expect(requestURL(original.mock.calls[0][0])).toBe(url);
});

test.each(["request", "stream"])(
  "preserves one-shot direct bodies (%s)",
  async (kind) => {
    const seen: Request[] = [];
    const bodies: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      bodies.push(await request.text());
      return new Response("ok", {
        headers: { "x-lore-context-boundary": boundary(prefix) },
      });
    });
    install();
    await (await send(prefix)).text();
    const body = JSON.stringify({ model: "claude", messages: appended });
    if (kind === "request") {
      await fetch(new Request(url, { method: "POST", headers, body }));
    } else {
      await fetch(url, {
        method: "POST",
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        ...({ duplex: "half" } as RequestInit),
      });
    }
    expect(bodies[1]).toBe(body);
    expect(seen[1].headers.get("x-lore-context-boundary")).toBeNull();
  },
);

test("bounds direct mismatch replay to one attempt", async () => {
  let attempts = 0;
  const original = vi.fn<typeof fetch>(async () =>
    ++attempts === 1
      ? new Response("ok", {
          headers: { "x-lore-context-boundary": boundary(prefix) },
        })
      : new Response("mismatch", {
          status: 409,
          headers: { "x-lore-context-boundary-mismatch": "true" },
        }),
  );
  globalThis.fetch = original;
  install();
  await (await send(prefix)).text();
  const response = await send(appended);
  expect(response.status).toBe(409);
  expect(original).toHaveBeenCalledTimes(3);
  await response.body?.cancel();
});

test("publishes direct boundaries only at caller-visible EOF", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
    calls.push(init!);
    return new Response("accepted", {
      headers: { "x-lore-context-boundary": boundary(prefix) },
    });
  });
  install();
  const unfinished = await send(prefix);
  const next = await send(appended);
  expect(
    new Headers(calls[1].headers).get("x-lore-context-boundary"),
  ).toBeNull();
  await next.body?.cancel();
  await unfinished.body?.cancel();
  await (await send(appended)).text();
  expect(
    new Headers(calls[2].headers).get("x-lore-context-boundary"),
  ).toBeNull();
  await (await send(appended)).text();
  expect(new Headers(calls[3].headers).get("x-lore-context-boundary")).toBe(
    boundary(prefix),
  );
});

test.each([
  ["direct", "init"],
  ["direct", "bytes"],
  ["direct", "arraybuffer"],
  ["direct", "url"],
  ["rewritten", "init"],
  ["rewritten", "bytes"],
  ["rewritten", "arraybuffer"],
  ["rewritten", "url"],
])(
  "replays the original dispatch after caller mutation (%s/%s)",
  async (route, mutation) => {
    const calls: Array<{
      url: string;
      method?: string;
      credentials?: RequestCredentials;
      signal?: AbortSignal | null;
      headers: Headers;
      body: string;
    }> = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const bytes = init?.body;
      calls.push({
        url: requestURL(input),
        method: init?.method,
        credentials: init?.credentials,
        signal: init?.signal,
        headers: new Headers(init?.headers),
        body:
          typeof bytes === "string"
            ? bytes
            : new TextDecoder().decode(bytes as Uint8Array),
      });
      if (calls.length === 2) {
        await blocked;
        return new Response("mismatch", {
          status: 409,
          headers: { "x-lore-context-boundary-mismatch": "true" },
        });
      }
      return new Response("ok", {
        headers: { "x-lore-context-boundary": boundary(prefix) },
      });
    });
    install();
    const destination = new URL(
      route === "direct" ? url : "https://provider.example/v1/messages",
    );
    await (
      await fetch(destination, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "claude", messages: prefix }),
      })
    ).text();
    const body = JSON.stringify({ model: "claude", messages: appended });
    const bytes = new TextEncoder().encode(`padding${body}tail`);
    const buffer = new TextEncoder().encode(body).buffer;
    const signal = new AbortController().signal;
    const init: RequestInit = {
      method: "POST",
      headers: { ...headers, authorization: "Bearer original" },
      credentials: "omit",
      signal,
      body:
        mutation === "bytes"
          ? bytes.subarray(7, 7 + body.length)
          : mutation === "arraybuffer"
            ? buffer
            : body,
    };
    const pending = fetch(destination, init);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    if (mutation === "init") {
      init.method = "PUT";
      init.credentials = "include";
      init.signal = new AbortController().signal;
      init.body = "replacement body";
      init.headers = { authorization: "Bearer replacement" };
    } else if (mutation === "bytes") {
      bytes.fill(120);
    } else if (mutation === "arraybuffer") {
      new Uint8Array(buffer).fill(120);
    } else {
      destination.href = "https://other-origin.example/v1/messages";
    }
    release();
    await (await pending).text();
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe(calls[1].url);
    expect(calls[2].method).toBe("POST");
    expect(calls[2].credentials).toBe("omit");
    expect(calls[2].signal).toBe(signal);
    expect(calls[2].headers.get("authorization")).toBe("Bearer original");
    expect(calls[2].body).toBe(body);
  },
);

test("direct continuation verifies generated histories and edits", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ maxLength: 100 }), { minLength: 1, maxLength: 16 }),
      fc.boolean(),
      async (texts, edit) => {
        const items = texts.map((content) => ({ role: "user", content }));
        const token = boundary(items);
        const calls: RequestInit[] = [];
        globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
          calls.push(init!);
          return new Response("ok", {
            headers: { "x-lore-context-boundary": token },
          });
        });
        install();
        try {
          await (await send(items)).text();
          const next = [...items, { role: "user", content: "next" }];
          if (edit)
            next[0] = { role: "user", content: `${next[0].content}edited` };
          await (await send(next)).text();
          expect(JSON.parse(calls[1].body as string).messages).toEqual(
            edit ? next : next.slice(items.length),
          );
          expect(
            new Headers(calls[1].headers).get("x-lore-context-boundary"),
          ).toBe(edit ? null : token);
        } finally {
          cleanup?.();
          cleanup = undefined;
        }
      },
    ),
    { seed: 20261025, numRuns: 60 },
  );
});
