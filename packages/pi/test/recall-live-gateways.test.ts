import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, expect, test, vi } from "vitest";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { RECALL_TOOL_NAME } from "@loreai/core";
import lorePiExtension from "../src/index";

vi.mock("../src/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/internal")>()),
  resolveGatewayUrl: async () => process.env.LORE_GATEWAY_URL ?? null,
}));
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
afterAll(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

test("live native clients keep observations after the idle cache evicts their gateway and during reload", async () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const factories: Array<{
    handlers: Map<string, (...args: unknown[]) => unknown>;
  }> = [];
  const received: Array<{
    gateway: number;
    path: string;
    key: string | undefined;
    session: string | undefined;
  }> = [];
  process.env.LORE_PI_FORCE_ACTIVE = "1";
  delete process.env.LORE_DISABLED;
  delete process.env.LORE_REMOTE_URL;
  try {
    const gateways: string[] = [];
    for (let index = 0; index < 5; index++) {
      const server = createServer((request, response) => {
        received.push({
          gateway: index,
          path: request.url!,
          key: request.headers["x-api-key"] as string | undefined,
          session: request.headers["x-lore-session-id"] as string | undefined,
        });
        request.resume();
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            request.url === "/v1/recall"
              ? { result: `memory-${index}-${request.headers["x-api-key"]}` }
              : {},
          ),
        );
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      gateways.push(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      );
    }
    const makeFactory = async (index: number, branch: unknown[] = []) => {
      process.env.LORE_GATEWAY_URL = gateways[index];
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const tools: ToolDefinition[] = [];
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
        registerTool(tool: ToolDefinition) {
          tools.push(tool);
        },
        on(event: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(event, handler);
        },
      } as unknown as Parameters<typeof lorePiExtension>[0]);
      const context = {
        cwd: `/tmp/pi-live-gateway-${index}`,
        signal: new AbortController().signal,
        sessionManager: {
          getSessionFile: () => `/tmp/pi-live-gateway-${index}.jsonl`,
          getSessionName: () => "",
          getBranch: () => branch,
        },
      };
      await handlers.get("session_start")?.({}, context);
      const instance = { handlers, context, tools, registrations, branch };
      factories.push(instance);
      return instance;
    };
    const active = [];
    for (let index = 0; index < 5; index++)
      active.push(await makeFactory(index));
    const call = async (instance: (typeof active)[number], id: string) => {
      const result = await instance.tools[0]!.execute(
        id,
        { query: "memory", scope: "session" },
        instance.context.signal,
        undefined,
        instance.context as unknown as ExtensionContext,
      );
      return result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    };
    const send = async (
      instance: (typeof active)[number],
      id: string,
      key: string,
      timestamp: number,
    ) => {
      await instance.handlers.get("agent_start")?.({}, instance.context);
      await instance.handlers.get("turn_start")?.({}, instance.context);
      const registration = instance.registrations.get("anthropic")!;
      const response = await fetch(`${registration.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...registration.headers, "x-api-key": key },
        body: "{}",
      });
      await response.text();
      const message = {
        role: "assistant",
        provider: "anthropic",
        model: "model",
        timestamp,
        content: [
          {
            type: "toolCall",
            id,
            name: RECALL_TOOL_NAME,
            arguments: { query: "memory" },
          },
        ],
      };
      await instance.handlers.get("message_start")?.(
        { message },
        instance.context,
      );
      instance.branch.push({ type: "message", id, message });
      await instance.handlers.get("agent_end")?.({}, instance.context);
    };
    for (let index = 0; index < 5; index++) {
      await send(active[index]!, `call-${index}`, `key-${index}`, index + 1);
      expect(await call(active[index]!, `call-${index}`)).toBe(
        `memory-${index}-key-${index}`,
      );
    }
    // Reload must recover the live gateway client, including its prior exact-turn observations.
    const reloaded = await makeFactory(0, active[0]!.branch);
    expect(await call(reloaded, "call-0")).toBe("memory-0-key-0");
    await send(reloaded, "call-rotated", "rotated-key", 100);
    expect(await call(reloaded, "call-rotated")).toBe("memory-0-rotated-key");
    expect(await call(active[0]!, "call-0")).toBe("memory-0-key-0");
    expect(
      received
        .filter((request) => request.path === "/v1/recall")
        .every((request) => request.session?.startsWith("pi-")),
    ).toBe(true);
  } finally {
    for (const instance of factories)
      await instance.handlers.get("session_shutdown")?.({});
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
