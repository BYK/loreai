/**
 * OpenCode sub-agent detection (#1300).
 *
 * A Task sub-agent runs in a child session whose `parentID` points at the
 * spawning session. The plugin's `chat.headers` hook resolves that parent via
 * the SDK and forwards it as `x-parent-session-id` — the same signal Claude
 * Code emits natively — so the gateway flags the session as a sub-agent and
 * sizes its LTM injection (#1302). Primary sessions have no parent and emit no
 * such header.
 *
 * The lookup is cached per session and must never block or break the request.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LorePlugin } from "../src/index";

interface MockOpts {
  /** session id → parentID it should report. Absent ⇒ primary (no parent). */
  parents?: Record<string, string>;
  /** Records every session.get(id) call. */
  calls?: string[];
  /** Records the workspace query passed to each session.get call. */
  queries?: Array<{ id: string; directory?: string }>;
  /** When true, session.get rejects (transient failure). */
  fail?: () => boolean;
}

function createMockClient(opts: MockOpts): PluginInput["client"] {
  return {
    tui: { showToast: () => Promise.resolve() },
    session: {
      get: (args: { path: { id: string }; query?: { directory?: string } }) => {
        const id = args?.path?.id;
        opts.calls?.push(id);
        opts.queries?.push({ id, directory: args.query?.directory });
        if (opts.fail?.()) return Promise.reject(new Error("server down"));
        const parentID =
          opts.parents?.[`${args.query?.directory}:${id}`] ??
          opts.parents?.[id];
        return Promise.resolve({
          data: parentID ? { id, parentID } : { id },
        });
      },
      list: () => Promise.resolve({ data: [] }),
      create: () => Promise.resolve({ data: { id: "worker_1" } }),
      messages: () => Promise.resolve({ data: [] }),
      message: () => Promise.resolve({ data: null }),
      prompt: () => Promise.resolve({ data: {} }),
    },
  } as unknown as PluginInput["client"];
}

async function initPlugin(directory: string, client: PluginInput["client"]) {
  return LorePlugin({
    client,
    project: { id: `proj-${directory}` } as unknown as PluginInput["project"],
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost:0"),
    $: {} as unknown as PluginInput["$"],
  });
}

type ChatHeadersHook = NonNullable<Hooks["chat.headers"]>;
type ChatHeadersInput = Parameters<ChatHeadersHook>[0];

function chatInput(sessionID: string): ChatHeadersInput {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
    provider: { id: "anthropic" },
    message: { id: "msg-1" },
  } as unknown as ChatHeadersInput;
}

async function headersFor(
  hooks: Hooks,
  sessionID: string,
): Promise<Record<string, string>> {
  const output = { headers: {} as Record<string, string> };
  await hooks["chat.headers"]?.(chatInput(sessionID), output);
  return output.headers;
}

async function waitForHeader(
  hooks: Hooks,
  sessionID: string,
  name: string,
  expected: string,
): Promise<void> {
  await vi.waitFor(async () => {
    const headers = await headersFor(hooks, sessionID);
    expect(headers[name]).toBe(expected);
  });
}

describe("OpenCode plugin — sub-agent detection (#1300)", () => {
  let tmpDirs: string[] = [];
  function makeTmp(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lore-subagent-${label}-`));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpDirs = [];
  });

  test("sub-agent session forwards its parentID as x-parent-session-id", async () => {
    const dir = makeTmp("sub");
    const client = createMockClient({
      parents: { "sa-child-1": "sa-parent-1" },
    });
    const hooks = await initPlugin(dir, client);

    const headers = await headersFor(hooks, "sa-child-1");
    expect(headers["x-lore-session-id"]).toBe("sa-child-1");
    expect(headers["x-lore-session-parent-state"]).toBe("pending");
    await waitForHeader(
      hooks,
      "sa-child-1",
      "x-parent-session-id",
      "sa-parent-1",
    );
  });

  test("primary session (no parentID) emits no x-parent-session-id", async () => {
    const calls: string[] = [];
    const dir = makeTmp("primary");
    const client = createMockClient({ parents: {}, calls });
    const hooks = await initPlugin(dir, client);

    const headers = await headersFor(hooks, "primary-1");
    expect(headers["x-parent-session-id"]).toBeUndefined();
    expect(headers["x-lore-session-id"]).toBe("primary-1");
    expect(headers["x-lore-session-parent-state"]).toBe("pending");
    await vi.waitFor(() => expect(calls).toEqual(["primary-1"]));
    const resolvedHeaders = await headersFor(hooks, "primary-1");
    expect(resolvedHeaders["x-parent-session-id"]).toBeUndefined();
    // The first request cannot wait for session.get(); it stays conservative
    // until the asynchronous lookup confirms this is a primary session.
    expect(resolvedHeaders["x-lore-session-parent-state"]).toBe("pending");
    const nextTurnHeaders = await headersFor(hooks, "primary-1");
    expect(nextTurnHeaders["x-lore-session-parent-state"]).toBe("primary");
    expect(calls).toEqual(["primary-1"]);
  });

  test("parent lookup is cached — session.get runs once across turns", async () => {
    const dir = makeTmp("cache");
    const calls: string[] = [];
    const client = createMockClient({
      parents: { "cache-child": "cache-parent" },
      calls,
    });
    const hooks = await initPlugin(dir, client);

    await headersFor(hooks, "cache-child");
    await waitForHeader(
      hooks,
      "cache-child",
      "x-parent-session-id",
      "cache-parent",
    );
    await headersFor(hooks, "cache-child");
    expect(calls.filter((id) => id === "cache-child")).toHaveLength(1);
  });

  test("scopes session metadata lookups to each workspace", async () => {
    const directoryA = makeTmp("workspace-a");
    const directoryB = makeTmp("workspace-b");
    const queries: Array<{ id: string; directory?: string }> = [];
    const client = createMockClient({
      parents: {
        [`${directoryA}:shared-session`]: "parent-a",
        [`${directoryB}:shared-session`]: "parent-b",
      },
      queries,
    });
    const hooksA = await initPlugin(directoryA, client);
    const hooksB = await initPlugin(directoryB, client);

    await headersFor(hooksA, "shared-session");
    await waitForHeader(
      hooksA,
      "shared-session",
      "x-parent-session-id",
      "parent-a",
    );
    await headersFor(hooksB, "shared-session");
    await waitForHeader(
      hooksB,
      "shared-session",
      "x-parent-session-id",
      "parent-b",
    );

    expect(queries).toEqual([
      { id: "shared-session", directory: directoryA },
      { id: "shared-session", directory: directoryB },
    ]);
  });

  test("a lookup failure is swallowed and NOT cached (retried next turn)", async () => {
    const dir = makeTmp("retry");
    let down = true; // first call fails, then recovers
    const client = createMockClient({
      parents: { "retry-child": "retry-parent" },
      fail: () => down,
    });
    const hooks = await initPlugin(dir, client);

    // Turn 1: lookup fails — no header, request not broken.
    const h1 = await headersFor(hooks, "retry-child");
    expect(h1["x-parent-session-id"]).toBeUndefined();
    expect(h1["x-lore-session-id"]).toBe("retry-child");

    // The first failure is not cached; once the server recovers, a later turn
    // retries and the following turn observes the refreshed metadata.
    down = false;
    await headersFor(hooks, "retry-child");
    await waitForHeader(
      hooks,
      "retry-child",
      "x-parent-session-id",
      "retry-parent",
    );
  });

  test("a non-throwing SDK error stays pending and retries rather than caching a primary session", async () => {
    const dir = makeTmp("sdk-error");
    const client = createMockClient({});
    let available = false;
    let calls = 0;
    client.session.get = (() => {
      calls++;
      return Promise.resolve(
        available
          ? { data: { id: "sdk-error-child", parentID: "sdk-error-parent" } }
          : { error: { message: "server unavailable" } },
      );
    }) as unknown as typeof client.session.get;
    const hooks = await initPlugin(dir, client);

    expect(
      (await headersFor(hooks, "sdk-error-child"))[
        "x-lore-session-parent-state"
      ],
    ).toBe("pending");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterError = await headersFor(hooks, "sdk-error-child");
    expect(afterError["x-lore-session-parent-state"]).toBe("pending");
    expect(afterError["x-parent-session-id"]).toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBeGreaterThanOrEqual(2);

    available = true;
    await waitForHeader(
      hooks,
      "sdk-error-child",
      "x-parent-session-id",
      "sdk-error-parent",
    );
  });

  test("a stalled session lookup never blocks provider headers", async () => {
    const dir = makeTmp("stalled");
    const client = createMockClient({});
    let rejectLookup: ((reason?: unknown) => void) | undefined;
    client.session.get = () =>
      new Promise<never>((_resolve, reject) => {
        rejectLookup = reject;
      });
    const hooks = await initPlugin(dir, client);

    vi.useFakeTimers();
    try {
      const result = Promise.race([
        headersFor(hooks, "stalled-child").then(() => "settled" as const),
        new Promise<"blocked">((resolve) => {
          setTimeout(() => resolve("blocked"), 100);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toBe("settled");
    } finally {
      vi.useRealTimers();
      rejectLookup?.(new Error("test cleanup"));
    }
  });

  test("a timed-out lookup releases its slot for a later retry", async () => {
    const dir = makeTmp("timeout-retry");
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const client = createMockClient({ parents: {}, calls });
    const sessionClient = client.session as unknown as {
      get(args: { path: { id: string } }): Promise<{
        data: { id: string; parentID: string };
      }>;
    };
    sessionClient.get = (args: { path: { id: string } }) => {
      calls.push(args.path.id);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              data: { id: args.path.id, parentID: "stale-parent" },
            });
        });
      }
      return Promise.resolve({
        data: { id: args.path.id, parentID: "timeout-parent" },
      });
    };
    const hooks = await initPlugin(dir, client);

    vi.useFakeTimers();
    try {
      const firstHeaders = await headersFor(hooks, "timeout-child");
      expect(firstHeaders["x-lore-session-parent-state"]).toBe("pending");
      // Advance the metadata deadline; the SDK request itself may never settle.
      await vi.advanceTimersByTimeAsync(5_000);
      await headersFor(hooks, "timeout-child");
      await vi.waitFor(async () => {
        const headers = await headersFor(hooks, "timeout-child");
        expect(headers["x-parent-session-id"]).toBe("timeout-parent");
      });
      expect(calls).toEqual(["timeout-child", "timeout-child"]);

      // A late completion from the timed-out call cannot replace newer metadata.
      releaseFirst?.();
      await Promise.resolve();
      expect(
        (await headersFor(hooks, "timeout-child"))["x-parent-session-id"],
      ).toBe("timeout-parent");
    } finally {
      vi.useRealTimers();
    }
  });
});
