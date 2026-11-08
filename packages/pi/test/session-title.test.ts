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
import { discoverWorkspaceRoot, getGitRemote } from "@loreai/core";
import { sessionIDFor } from "../src/internal";

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
    registerTool(): void {},
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

  const sessionCtx = (
    name: string | undefined,
    file = "/tmp/lore-pi-title-session.jsonl",
    cwd = process.cwd(),
  ) => ({
    cwd,
    sessionManager: {
      getSessionFile: () => file,
      getSessionName: () => name,
    },
  });

  /** Fire a provider-shaped fetch and return the headers the gateway saw. */
  async function interceptHeaders(
    extra: Record<string, string> = {},
  ): Promise<Headers> {
    capturedHeaders = undefined;
    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "k",
        "content-type": "application/json",
        ...extra,
      },
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
    const project = discoverWorkspaceRoot(process.cwd());
    expect(headers.get("x-lore-session-id")).toBe(
      sessionIDFor(sessionCtx(undefined).sessionManager.getSessionFile()),
    );
    expect(headers.get("x-lore-project")).toBe(project);
    expect(headers.get("x-lore-git-remote")).toBe(
      getGitRemote(project) ?? null,
    );
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
  test("auxiliary requests never borrow another live factory's metadata or pending turn", async () => {
    const other = createMockPi();
    await lorePiExtension(
      other.pi as unknown as Parameters<typeof lorePiExtension>[0],
    );
    const firstContext = sessionCtx("First owner");
    const otherContext = sessionCtx(
      "Other owner",
      "/tmp/pi-other-session.jsonl",
      "/tmp/pi-other-project",
    );
    await mock.handlers.get("session_start")?.({}, firstContext);
    await other.handlers.get("session_start")?.({}, otherContext);
    // A is issuing a model turn while B can issue untagged title/embedding requests.
    await mock.handlers.get("turn_start")?.({}, firstContext);
    const ambiguous = await interceptHeaders();
    for (const header of [
      "x-lore-session-id",
      "x-lore-project",
      "x-lore-session-title",
      "x-lore-git-remote",
    ])
      expect(ambiguous.get(header)).toBeNull();
    const scoped = await interceptHeaders({
      "x-lore-session-id": sessionIDFor(
        otherContext.sessionManager.getSessionFile(),
      ),
      "x-lore-project": otherContext.cwd,
    });
    expect(scoped.get("x-lore-session-title")).toBe("Other%20owner");
    expect(scoped.get("x-lore-git-remote")).toBeNull();
    const mismatch = await interceptHeaders({
      "x-lore-project": "/unknown-project",
    });
    expect(mismatch.get("x-lore-session-id")).toBeNull();
    expect(mismatch.get("x-lore-session-title")).toBeNull();
    await mock.handlers.get("session_shutdown")?.({});
    const remaining = await interceptHeaders();
    expect(remaining.get("x-lore-session-id")).toBe(
      sessionIDFor(otherContext.sessionManager.getSessionFile()),
    );
    expect(remaining.get("x-lore-project")).toBe(otherContext.cwd);
    expect(remaining.get("x-lore-session-title")).toBe("Other%20owner");
    await other.handlers.get("session_shutdown")?.({});
    expect((await interceptHeaders()).get("x-lore-session-id")).toBeNull();
    // The process-wide interceptor must consult the reloaded live factory.
    const reloaded = createMockPi();
    await lorePiExtension(
      reloaded.pi as unknown as Parameters<typeof lorePiExtension>[0],
    );
    await reloaded.handlers.get("session_start")?.(
      {},
      sessionCtx("Reloaded owner"),
    );
    expect((await interceptHeaders()).get("x-lore-session-title")).toBe(
      "Reloaded%20owner",
    );
    await reloaded.handlers.get("session_shutdown")?.({});
  });
});
