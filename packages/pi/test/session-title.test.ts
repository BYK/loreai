/**
 * Pi session title forwarding (#1921).
 *
 * The extension reads `ctx.sessionManager.getSessionName()` on session_start
 * (and refreshes it on before_agent_start so a mid-session /name is picked
 * up) and injects it percent-encoded as `x-lore-session-title` into every
 * rerouted provider request. Sessions with no name emit no header.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import lorePiExtension from "../src/index";

type AnyHandler = (...args: unknown[]) => unknown;
interface Registration {
  name: string;
  config: { baseUrl: string; headers: Record<string, string> };
}
function createMockPi() {
  const registrations: Registration[] = [];
  const handlers = new Map<string, AnyHandler>();
  const pi = {
    registerProvider(
      name: string,
      config: { baseUrl: string; headers: Record<string, string> },
    ): void {
      registrations.push({ name, config });
    },
    on(event: string, handler: AnyHandler): void {
      handlers.set(event, handler);
    },
  };
  return { pi, registrations, handlers };
}

const GATEWAY_BASE = "http://127.0.0.1:59999";

describe("pi extension — x-lore-session-title", () => {
  let mock: ReturnType<typeof createMockPi>;
  let capturedHeaders: Headers | undefined;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  const sessionCtx = (name: string | undefined) => ({
    cwd: process.cwd(),
    sessionManager: {
      getSessionFile: () => "/tmp/lore-pi-title-session.jsonl",
      getSessionName: () => name,
    },
  });

  /** Fire a provider-shaped fetch and return the headers the gateway saw. */
  async function interceptHeaders(): Promise<Headers> {
    capturedHeaders = undefined;
    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      body: "{}",
    });
    expect(capturedHeaders).toBeDefined();
    return capturedHeaders!;
  }

  beforeAll(async () => {
    // Stand in for the real network so nothing leaves the test process.
    globalThis.fetch = (input, init) => {
      const req = new Request(input, init);
      capturedHeaders = req.headers;
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    process.env.LORE_PI_FORCE_ACTIVE = "1";
    process.env.LORE_GATEWAY_URL = GATEWAY_BASE;
    delete process.env.LORE_DISABLED;
    delete process.env.LORE_REMOTE_URL;

    mock = createMockPi();
    await lorePiExtension(
      mock.pi as unknown as Parameters<typeof lorePiExtension>[0],
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("header is absent until the session has a name", async () => {
    await mock.handlers.get("session_start")?.({}, sessionCtx(undefined));
    const headers = await interceptHeaders();
    expect(headers.get("x-lore-session-title")).toBeNull();
  });

  test("session_start name is forwarded percent-encoded", async () => {
    await mock.handlers.get("session_start")?.(
      {},
      sessionCtx("Fix the Ünïcode bug"),
    );
    const headers = await interceptHeaders();
    expect(headers.get("x-lore-session-title")).toBe(
      "Fix%20the%20%C3%9Cn%C3%AFcode%20bug",
    );
  });

  test("before_agent_start refreshes a mid-session /name", async () => {
    await mock.handlers.get("before_agent_start")?.(
      {},
      sessionCtx("Renamed session"),
    );
    const headers = await interceptHeaders();
    expect(headers.get("x-lore-session-title")).toBe("Renamed%20session");
    // Clearing the name removes the header again.
    await mock.handlers.get("before_agent_start")?.({}, sessionCtx(undefined));
    const cleared = await interceptHeaders();
    expect(cleared.get("x-lore-session-title")).toBeNull();
  });
});
