import { afterEach, describe, expect, test, vi } from "vitest";
import { createGatewayRecallClient } from "../src/recall-gateway-client";

describe("native recall gateway client", () => {
  test("binds gateway access credentials and their absence to the exact observed turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        return Response.json({
          result: headers.get("x-lore-gateway-token") ?? "keyless",
        });
      }),
    );
    const client = createGatewayRecallClient("https://gateway.example");
    const context = {
      projectPath: "/project",
      sessionID: "session",
      providerID: "anthropic",
    };
    const observe = (turnID: string, token?: string) =>
      client.observeRequestHeaders(
        new Headers({
          "x-lore-project": context.projectPath,
          "x-lore-session-id": context.sessionID,
          "x-lore-provider": context.providerID,
          "x-lore-native-turn-id": turnID,
          "x-api-key": "same-provider-key",
          ...(token ? { "x-lore-gateway-token": token } : {}),
        }),
      );
    observe("a", "access-a");
    observe("b", "access-b");
    observe("none");
    for (const [turnID, expected] of [
      ["a", "access-a"],
      ["b", "access-b"],
      ["none", "keyless"],
    ])
      expect(
        await client.execute({ query: "memory" }, { ...context, turnID }),
      ).toBe(expected);
    observe("a", "access-b");
    expect(
      await client.execute({ query: "memory" }, { ...context, turnID: "a" }),
    ).toContain("unavailable");
    observe("b");
    expect(
      await client.execute({ query: "memory" }, { ...context, turnID: "b" }),
    ).toContain("unavailable");
  });
  test("accepts a sole nameless observation only for an exact verified turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        Response.json({ result: new Headers(init.headers).get("x-api-key") }),
      ),
    );
    const client = createGatewayRecallClient("http://127.0.0.1:3207");
    const context = {
      projectPath: "/project",
      sessionID: "session",
      providerID: "custom",
      turnID: "turn",
    };
    const headers = new Headers({
      "x-lore-project": context.projectPath,
      "x-lore-session-id": context.sessionID,
      "x-lore-native-turn-id": context.turnID,
      "x-api-key": "custom-token",
    });
    client.observeRequestHeaders(headers);
    expect(await client.execute({ query: "memory" }, context)).toBe(
      "custom-token",
    );
    expect(
      await client.execute(
        { query: "memory" },
        { ...context, turnID: undefined },
      ),
    ).toContain("unavailable");
    headers.set("x-lore-provider", "another-provider");
    headers.set("x-api-key", "another-token");
    client.observeRequestHeaders(headers);
    expect(await client.execute({ query: "memory" }, context)).toContain(
      "unavailable",
    );
  });
  test("binds rotated and overlapping credentials to exact turns without widening session/project scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        Response.json({ result: new Headers(init.headers).get("x-api-key") }),
      ),
    );
    const client = createGatewayRecallClient("http://127.0.0.1:3207");
    const base = {
      projectPath: "/project",
      sessionID: "session",
      providerID: "anthropic",
    };
    const observe = (turnID: string, key: string) =>
      client.observeRequestHeaders(
        new Headers({
          "x-lore-project": base.projectPath,
          "x-lore-session-id": base.sessionID,
          "x-lore-provider": base.providerID,
          "x-lore-native-turn-id": turnID,
          "x-api-key": key,
        }),
      );
    observe("turn-a", "token-a");
    observe("turn-b", "token-b");
    expect(
      await client.execute({ query: "memory" }, { ...base, turnID: "turn-a" }),
    ).toBe("token-a");
    expect(
      await client.execute({ query: "memory" }, { ...base, turnID: "turn-b" }),
    ).toBe("token-b");
    for (const invalid of [
      { turnID: "missing" },
      { turnID: "turn-a", projectPath: "/other" },
      { turnID: "turn-a", sessionID: "other" },
      {},
    ]) {
      expect(
        await client.execute({ query: "memory" }, { ...base, ...invalid }),
      ).toContain("unavailable");
    }
    observe("turn-b", "conflicting-token");
    expect(
      await client.execute({ query: "memory" }, { ...base, turnID: "turn-b" }),
    ).toContain("unavailable");
    expect(
      await client.execute({ query: "memory" }, { ...base, turnID: "turn-a" }),
    ).toBe("token-a");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("keeps provider switches independent while refusing same-provider credential ambiguity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        Response.json({ result: new Headers(init.headers).get("x-api-key") }),
      ),
    );
    const client = createGatewayRecallClient("http://127.0.0.1:3207");
    const context = { projectPath: "/project", sessionID: "session" };
    const observe = (providerID: string, key: string) =>
      client.observeRequestHeaders(
        new Headers({
          "x-lore-project": context.projectPath,
          "x-lore-session-id": context.sessionID,
          "x-lore-provider": providerID,
          "x-api-key": key,
        }),
      );
    observe("anthropic", "key-a");
    observe("minimax", "key-b");
    expect(
      await client.execute(
        { query: "memory" },
        { ...context, providerID: "anthropic" },
      ),
    ).toBe("key-a");
    expect(
      await client.execute(
        { query: "memory" },
        { ...context, providerID: "minimax" },
      ),
    ).toBe("key-b");
    expect(await client.execute({ query: "memory" }, context)).toContain(
      "unavailable",
    );
    observe("minimax", "another-key-b");
    expect(
      await client.execute(
        { query: "memory" },
        { ...context, providerID: "minimax" },
      ),
    ).toContain("unavailable");
    expect(
      await client.execute(
        { query: "memory" },
        { ...context, providerID: "anthropic" },
      ),
    ).toBe("key-a");
  });

  test("expires observed credentials and requires a fresh authenticated generation request", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn(async () => Response.json({ result: "memory" }));
    vi.stubGlobal("fetch", fetch);
    const client = createGatewayRecallClient("http://127.0.0.1:3207");
    const headers = new Headers({
      "x-lore-project": "/project",
      "x-lore-session-id": "session",
      "x-api-key": "key",
    });
    client.observeRequestHeaders(headers);
    const context = { projectPath: "/project", sessionID: "session" };
    expect(await client.execute({ query: "memory" }, context)).toBe("memory");
    now += 30 * 60 * 1000;
    expect(await client.execute({ query: "memory" }, context)).toContain(
      "unavailable",
    );
    expect(fetch).toHaveBeenCalledOnce();
    client.observeRequestHeaders(headers);
    expect(await client.execute({ query: "memory" }, context)).toBe("memory");
  });

  test("isolates observed credentials by project and session and refuses ambiguous owners", async () => {
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init);
      return Response.json({ result: "gateway memory" });
    });
    vi.stubGlobal("fetch", fetch);
    const client = createGatewayRecallClient("http://127.0.0.1:3207");
    const observe = (project: string, session: string, key: string) =>
      client.observeRequestHeaders(
        new Headers({
          "x-lore-project": project,
          "x-lore-session-id": session,
          "x-lore-gateway-token": "access",
          "x-api-key": key,
        }),
      );
    const call = (projectPath: string, sessionID: string) =>
      client.execute({ query: "memory" }, { projectPath, sessionID });
    observe("/project-a", "session-a", "key-a");
    observe("/project-b", "session-a", "key-b");
    observe("/project-a", "session-b", "key-c");
    expect(await call("/project-a", "session-a")).toBe("gateway memory");
    expect(await call("/project-b", "session-a")).toBe("gateway memory");
    expect(await call("/project-a", "session-b")).toBe("gateway memory");
    expect(
      requests.map((request) => new Headers(request.headers).get("x-api-key")),
    ).toEqual(["key-a", "key-b", "key-c"]);
    expect(requests[0]).toMatchObject({ redirect: "error" });
    expect(new Headers(requests[0].headers).get("x-lore-gateway-token")).toBe(
      "access",
    );
    observe("/project-a", "session-a", "key-b");
    expect(await call("/project-a", "session-a")).toContain("unavailable");
    expect(await call("/project-unknown", "session-a")).toContain(
      "unavailable",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await call("/project-a", "session-b")).toBe("gateway memory");
  });

  test("propagates cancellation and never reveals gateway errors or redirects", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(new Error("private provider credential")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = createGatewayRecallClient("http://127.0.0.1:3207");
    client.observeRequestHeaders(
      new Headers({
        "x-lore-project": "/project",
        "x-lore-session-id": "session",
        authorization: "Bearer private",
      }),
    );
    const pending = client.execute(
      { query: "private search" },
      {
        projectPath: "/project",
        sessionID: "session",
        signal: controller.signal,
      },
    );
    controller.abort();
    expect(await pending).toBe("Recall was cancelled.");
    fetch.mockImplementation(
      async () =>
        new Response("private error body", {
          status: 302,
          headers: { location: "https://other.example" },
        }),
    );
    expect(
      await client.execute(
        { query: "search" },
        { projectPath: "/project", sessionID: "session" },
      ),
    ).toBe("Recall is unavailable for this authenticated session.");
    expect(fetch.mock.calls[1][1].redirect).toBe("error");
  });
});
