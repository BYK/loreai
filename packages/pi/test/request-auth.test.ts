import { afterAll, afterEach, expect, test } from "vitest";
import { GATEWAY_AUTH_HEADER } from "@loreai/core";
import lorePiExtension from "../src/index";
import { sessionIDFor } from "../src/internal";

const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const requests: Request[] = [];
const liveHandlers: Array<Map<string, (...args: unknown[]) => unknown>> = [];
afterEach(async () => {
  for (const handlers of liveHandlers.splice(0))
    await handlers.get("session_shutdown")?.({});
});
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  requests.push(request);
  return Response.json({});
};
afterAll(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
});
const gatewayA = "https://gateway-a.example.test";
const gatewayB = "https://gateway-b.example.test";
async function factory(gateway: string, token: string, name: string) {
  process.env.LORE_PI_FORCE_ACTIVE = "1";
  process.env.LORE_REMOTE_URL = gateway;
  process.env.LORE_GATEWAY_AUTH_TOKEN = token;
  delete process.env.LORE_GATEWAY_URL;
  delete process.env.LORE_DISABLED;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  liveHandlers.push(handlers);
  const registrations = new Map<
    string,
    { baseUrl: string; headers: Record<string, string> }
  >();
  await lorePiExtension({
    registerProvider(
      provider: string,
      config: { baseUrl: string; headers: Record<string, string> },
    ) {
      registrations.set(provider, config);
    },
    registerTool() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as Parameters<typeof lorePiExtension>[0]);
  const context = {
    cwd: `/tmp/${name}`,
    sessionManager: {
      getSessionFile: () => `/tmp/${name}.jsonl`,
      getSessionName: () => name,
    },
  };
  await handlers.get("session_start")?.({}, context);
  return { handlers, registrations, context, token };
}
async function send(
  url = "https://api.anthropic.com/v1/messages",
  headers: Record<string, string> = {},
) {
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "provider-key",
      ...headers,
    },
    body: "{}",
  });
  return requests.at(-1)!;
}
async function compact(instance: Awaited<ReturnType<typeof factory>>) {
  await instance.handlers.get("session_before_compact")?.(
    {
      preparation: {
        previousSummary: "",
        firstKeptEntryId: "e1",
        tokensBefore: 100,
      },
    },
    instance.context,
  );
  return requests.at(-1)!;
}

test("a retired first factory never supplies gateway access to the remaining owner", async () => {
  const first = await factory(gatewayA, "access-a", "retired-owner-a");
  const second = await factory(gatewayA, "access-b", "remaining-owner-b");
  await first.handlers.get("session_shutdown")?.({});
  const request = await send();
  expect(request.headers.get("x-lore-session-id")).toBe(
    sessionIDFor(second.context.sessionManager.getSessionFile()),
  );
  expect(request.headers.get(GATEWAY_AUTH_HEADER)).toBe(second.token);
});

test("shared factories keep gateway and provider credentials with their owner across rotation and shutdown", async () => {
  const first = await factory(gatewayA, "gateway-token-a", "owner-a");
  expect((await send()).headers.get(GATEWAY_AUTH_HEADER)).toBe(first.token);
  const second = await factory(gatewayA, "gateway-token-b", "owner-b");
  await first.handlers.get("turn_start")?.({}, first.context);
  expect(
    first.registrations.get("anthropic")!.headers[GATEWAY_AUTH_HEADER],
  ).toBe(first.token);
  const selectedSecond = await send(undefined, {
    "x-lore-project": second.context.cwd,
    "x-lore-session-id": sessionIDFor(
      second.context.sessionManager.getSessionFile(),
    ),
  });
  expect(selectedSecond.headers.get(GATEWAY_AUTH_HEADER)).toBe(second.token);
  const ambiguous = await send();
  expect(ambiguous.url).toBe("https://api.anthropic.com/v1/messages");
  expect(ambiguous.headers.get(GATEWAY_AUTH_HEADER)).toBeNull();
  const scoped = await send(undefined, {
    "x-lore-project": second.context.cwd,
    "x-lore-session-id": sessionIDFor(
      second.context.sessionManager.getSessionFile(),
    ),
    "x-api-key": "provider-b",
  });
  expect(scoped.headers.get(GATEWAY_AUTH_HEADER)).toBe(second.token);
  expect((await compact(second)).headers.get("x-api-key")).toBe("provider-b");
  // Gateway health/management auth has no model-request ownership scope.
  await fetch(`${gatewayA}/health`, {
    headers: {
      [GATEWAY_AUTH_HEADER]: second.token,
      authorization: "Bearer unrelated-health-auth",
    },
  });
  const afterHealth = await compact(second);
  expect(afterHealth.headers.get("x-api-key")).toBe("provider-b");
  expect(afterHealth.headers.get("authorization")).toBeNull();
  const firstScoped = await send(undefined, {
    "x-lore-project": first.context.cwd,
    "x-lore-session-id": sessionIDFor(
      first.context.sessionManager.getSessionFile(),
    ),
    "x-api-key": "provider-a",
  });
  expect(firstScoped.headers.get(GATEWAY_AUTH_HEADER)).toBe(first.token);
  expect((await compact(first)).headers.get("x-api-key")).toBe("provider-a");
  await first.handlers.get("session_shutdown")?.({});
  const remaining = await send(undefined, {
    "x-api-key": "provider-b-rotated",
  });
  expect(remaining.headers.get(GATEWAY_AUTH_HEADER)).toBe(second.token);
  const compacted = await compact(second);
  expect(compacted.headers.get(GATEWAY_AUTH_HEADER)).toBe(second.token);
  expect(compacted.headers.get("x-api-key")).toBe("provider-b-rotated");
  await second.handlers.get("session_shutdown")?.({});
  const rotated = await factory(gatewayA, "gateway-token-b-rotated", "owner-b");
  expect((await send()).headers.get(GATEWAY_AUTH_HEADER)).toBe(rotated.token);
  await rotated.handlers.get("session_shutdown")?.({});
});

test("distinct gateway destinations are preserved and ambiguous upstream requests never route to the first gateway", async () => {
  const first = await factory(gatewayA, "token-a", "gateway-owner-a");
  const second = await factory(gatewayB, "token-b", "gateway-owner-b");
  const registration = second.registrations.get("anthropic")!;
  const target = `${registration.baseUrl}/v1/messages`;
  const direct = await send(target, {
    ...registration.headers,
    "x-api-key": "provider-b",
  });
  expect(direct.url).toBe(target);
  expect(direct.headers.get(GATEWAY_AUTH_HEADER)).toBe("token-b");
  expect(direct.headers.get("x-lore-upstream-url")).toBeNull();
  const request = new Request(target, {
    method: "POST",
    headers: { ...registration.headers, "x-api-key": "provider-b" },
    body: "{}",
  });
  await fetch(request);
  expect(requests.at(-1)!.url).toBe(target);
  expect(requests.at(-1)!.headers.get(GATEWAY_AUTH_HEADER)).toBe("token-b");
  await fetch(new URL(target), {
    method: "POST",
    headers: registration.headers,
    body: "{}",
  });
  expect(requests.at(-1)!.url).toBe(target);
  expect(requests.at(-1)!.redirect).toBe("manual");

  expect((await compact(second)).url).toBe(`${gatewayB}/v1/compact`);
  const ambiguous = await send();
  expect(ambiguous.url).toBe("https://api.anthropic.com/v1/messages");
  expect(ambiguous.headers.get(GATEWAY_AUTH_HEADER)).toBeNull();
  const internalHeaders = {
    "x-api-key": "provider-key",
    "x-lore-gateway-token": "unknown-token",
    "x-lore-native-turn-id": "private-turn",
    "x-lore-context-boundary": "private-boundary",
    "x-lore-context-boundary-capability": "v1",
    "x-lore-session-id": "unknown-session",
    "x-lore-project": "/unknown-project",
  };
  const unowned = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: internalHeaders,
    body: "{}",
  });
  await fetch(unowned);
  const bypass = requests.at(-1)!;
  expect(bypass.url).toBe(unowned.url);
  expect(
    [...bypass.headers.keys()].filter((name) => name.startsWith("x-lore-")),
  ).toEqual([]);
  expect(bypass.headers.get("x-api-key")).toBe("provider-key");
  expect(bypass.redirect).toBe("manual");
  expect(unowned.headers.get(GATEWAY_AUTH_HEADER)).toBe("unknown-token");
  const scoped = await send(undefined, {
    "x-lore-project": second.context.cwd,
    "x-lore-session-id": sessionIDFor(
      second.context.sessionManager.getSessionFile(),
    ),
  });
  expect(scoped.url).toBe(`${gatewayB}/v1/messages`);
  expect(scoped.headers.get(GATEWAY_AUTH_HEADER)).toBe("token-b");
  await second.handlers.get("session_shutdown")?.({});
  const delayed = await send(target, registration.headers);
  expect(delayed.url).toBe(target);
  expect(delayed.headers.get(GATEWAY_AUTH_HEADER)).toBe("token-b");
  expect((await send()).url).toBe(`${gatewayA}/v1/messages`);
  await first.handlers.get("session_shutdown")?.({});
});
