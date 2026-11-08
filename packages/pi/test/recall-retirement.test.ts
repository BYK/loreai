import { afterEach, expect, test, vi } from "vitest";
import { RECALL_TOOL_NAME } from "@loreai/core";
import lorePiExtension from "../src/index";
import { sessionIDFor } from "../src/internal";
import { piTurnGroup } from "../src/recall-turns";
import { recallOriginKey } from "../src/recall-origin";

vi.mock("../src/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/internal")>()),
  resolveGatewayUrl: async () => "http://127.0.0.1:3207",
}));
vi.mock("@loreai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@loreai/core")>()),
  installFetchInterceptor: () => () => {},
}));

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

test.each(["shutdown", "compact"] as const)(
  "actual Pi %s retires only the interrupted factory without agent_end",
  async (operation) => {
    process.env.LORE_PI_FORCE_ACTIVE = "1";
    delete process.env.LORE_DISABLED;
    delete process.env.LORE_REMOTE_URL;
    const sessionFile = `/tmp/pi-retirement-${crypto.randomUUID()}.json`;
    const makeFactory = async () => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      await lorePiExtension({
        registerProvider() {},
        registerTool() {},
        on(event: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(event, handler);
        },
      } as unknown as Parameters<typeof lorePiExtension>[0]);
      const controller = new AbortController();
      const context = {
        cwd: process.cwd(),
        signal: controller.signal,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionName: () => "",
          getBranch: () => [],
        },
      };
      await handlers.get("session_start")?.({}, context);
      await handlers.get("agent_start")?.({}, context);
      await handlers.get("turn_start")?.({}, context);
      return { handlers, context, controller };
    };
    const first = await makeFactory();
    const originA = { providerID: "anthropic", modelID: "model", timestamp: 1 };
    await first.handlers.get("message_start")?.(
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "model",
          timestamp: 1,
          content: [{ type: "toolCall", id: "a", name: RECALL_TOOL_NAME }],
        },
      },
      first.context,
    );
    const second = await makeFactory();
    const originB = { ...originA, timestamp: 2 };
    await second.handlers.get("message_start")?.(
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "model",
          timestamp: 2,
          content: [{ type: "toolCall", id: "b", name: RECALL_TOOL_NAME }],
        },
      },
      second.context,
    );
    await first.handlers.get("turn_start")?.({}, first.context);
    await second.handlers.get("turn_start")?.({}, second.context);
    const group = piTurnGroup(
      "http://127.0.0.1:3207",
      process.cwd(),
      sessionIDFor(sessionFile),
    )!;
    expect(group.active).toBe(2);
    expect(group.pending.size).toBe(2);
    const secondPending = [...group.pending].find(
      ([, value]) => value.turnID !== [...group.pending.values()][0]?.turnID,
    )![0];

    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { AgentSession } = await import(
      /* @vite-ignore */ new URL("./core/agent-session.js", entry).href
    );
    if (operation === "shutdown") {
      const { AgentSessionRuntime } = await import(
        /* @vite-ignore */ new URL("./core/agent-session-runtime.js", entry)
          .href
      );
      let disposed = false;
      const runner = {
        hasHandlers: (event: string) => first.handlers.has(event),
        emit: (event: { type: string }) =>
          first.handlers.get(event.type)?.(event, first.context),
        invalidate() {},
      };
      const session = {
        extensionRunner: runner,
        _extensionRunner: runner,
        abortRetry() {},
        abortCompaction() {},
        abortBranchSummary() {},
        abortBash() {},
        agent: { abort: () => first.controller.abort() },
        _unsubscribeAgent: () => {
          disposed = true;
        },
        _disconnectFromAgent: AgentSession.prototype._disconnectFromAgent,
        sessionId: sessionIDFor(sessionFile),
        dispose: AgentSession.prototype.dispose,
      };
      const runtime = new AgentSessionRuntime(
        session,
        { cwd: process.cwd() },
        async () => {
          throw new Error("unused");
        },
      );
      await runtime.teardownCurrent("resume", sessionFile);
      expect(disposed).toBe(true);
      expect(first.controller.signal.aborted).toBe(true);
    } else {
      let disconnected = false;
      const session = {
        _unsubscribeAgent: () => {
          disconnected = true;
        },
        _disconnectFromAgent: AgentSession.prototype._disconnectFromAgent,
        _reconnectToAgent() {},
        abort: AgentSession.prototype.abort,
        abortRetry() {},
        agent: {
          abort: () => first.controller.abort(),
          waitForIdle: async () => {},
        },
        _emit() {},
        model: undefined,
      };
      await expect(
        AgentSession.prototype.compact.call(session),
      ).rejects.toThrow();
      expect(disconnected).toBe(true);
    }
    // Neither actual SDK path emits agent_end after disconnecting this owner.
    expect(group.active).toBe(1);
    expect([...group.pending.keys()]).toEqual([secondPending]);
    expect(group.origins.get(recallOriginKey(originA))).toBeNull();
    expect(group.origins.get(recallOriginKey(originB))).toBeTruthy();
    expect(group.ambiguous).toBe(true);
    await second.handlers.get("agent_end")?.({}, second.context);
    expect(group.active).toBe(0);
    expect(group.pending.size).toBe(0);
    expect(group.ambiguous).toBe(false);
    const resumed = await makeFactory();
    expect(group.pending.size).toBe(1);
    expect(group.ambiguous).toBe(false);
    await resumed.handlers.get("agent_end")?.({}, resumed.context);
  },
);
