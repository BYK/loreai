import { afterEach, expect, test, vi } from "vitest";
import { installFetchInterceptor, RECALL_TOOL_NAME } from "@loreai/core";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import lorePiExtension from "../src/index";

const gateway = "http://127.0.0.1:3207";
vi.mock("../src/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/internal")>()),
  resolveGatewayUrl: async () => "http://127.0.0.1:3207",
}));
vi.mock("@loreai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@loreai/core")>()),
  installFetchInterceptor: vi.fn(),
}));

const owners: Array<Map<string, (...args: unknown[]) => unknown>> = [];
afterEach(async () => {
  for (const handlers of owners.splice(0))
    await handlers.get("session_shutdown")?.({});
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each([
  ["removed", ["legacy-a", undefined]],
  ["added", [undefined, "legacy-a"]],
  ["changed", ["legacy-a", "legacy-b"]],
])(
  "Pi native recall ignores %s legacy tokens through header observation and execution",
  async (_label, tokens) => {
    vi.stubEnv("LORE_PI_FORCE_ACTIVE", "1");
    vi.stubEnv("LORE_DISABLED", undefined);
    vi.stubEnv("LORE_REMOTE_URL", undefined);
    vi.stubEnv("LORE_GATEWAY_URL", gateway);
    const fetch = vi.fn(async () =>
      Response.json({ result: "native gateway memory" }),
    );
    vi.stubGlobal("fetch", fetch);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    owners.push(handlers);
    const registerTool = vi.fn<(tool: ToolDefinition) => void>();
    const registerProvider =
      vi.fn<
        (name: string, config: { headers: Record<string, string> }) => void
      >();
    await lorePiExtension({
      registerTool,
      registerProvider,
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as Parameters<typeof lorePiExtension>[0]);
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "fixture-model",
      timestamp: 1,
      content: [
        { type: "toolCall", id: "recall-call", name: RECALL_TOOL_NAME },
      ],
    };
    const sessionFile = `/tmp/pi-legacy-recall-${crypto.randomUUID()}.jsonl`;
    const context = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionName: () => "legacy recall fixture",
        getBranch: () => [{ type: "message", id: "entry", message }],
      },
    } as unknown as ExtensionContext;
    for (const event of ["session_start", "agent_start", "turn_start"])
      await handlers.get(event)?.({}, context);
    const registration = registerProvider.mock.calls.findLast(
      ([name]) => name === "anthropic",
    )![1];
    const headers = new Headers({
      ...registration.headers,
      "x-lore-provider": "anthropic",
      "x-api-key": "provider-key",
    });
    const observer = vi.mocked(installFetchInterceptor).mock.calls[0][0]
      .onRequestHeaders!;
    for (const token of tokens) {
      if (token) headers.set("x-lore-gateway-token", token);
      else headers.delete("x-lore-gateway-token");
      observer(headers, gateway);
    }
    await handlers.get("message_start")?.({ message }, context);
    const tool = registerTool.mock.calls[0][0];
    const execute = () =>
      tool.execute(
        "recall-call",
        { query: "memory" },
        new AbortController().signal,
        undefined,
        context,
      );
    expect(await execute()).toEqual({
      content: [{ type: "text", text: "native gateway memory" }],
      details: undefined,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(`${gateway}/v1/recall`);
    expect(init?.redirect).toBe("error");
    const sent = new Headers(init?.headers);
    expect(sent.get("x-lore-gateway-token")).toBeNull();
    expect(sent.get("x-api-key")).toBe("provider-key");
    expect(sent.get("x-lore-session-id")).toBe(
      headers.get("x-lore-session-id"),
    );
    expect(sent.get("x-lore-native-turn-id")).toBe(
      headers.get("x-lore-native-turn-id"),
    );
    // Ignoring a retired gateway header must never hide a real provider conflict.
    headers.set("x-api-key", "conflicting-provider-key");
    observer(headers, gateway);
    expect(JSON.stringify(await execute())).toContain("unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  },
);
