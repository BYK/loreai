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
import { afterEach, describe, expect, test } from "vitest";
import { LorePlugin } from "../src/index";

interface MockOpts {
  /** session id → parentID it should report. Absent ⇒ primary (no parent). */
  parents?: Record<string, string>;
  /** Records every session.get(id) call. */
  calls?: string[];
  /** When true, session.get rejects (transient failure). */
  fail?: () => boolean;
}

function createMockClient(opts: MockOpts): PluginInput["client"] {
  return {
    tui: { showToast: () => Promise.resolve() },
    session: {
      get: (args: { path: { id: string } }) => {
        const id = args?.path?.id;
        opts.calls?.push(id);
        if (opts.fail?.()) return Promise.reject(new Error("server down"));
        const parentID = opts.parents?.[id];
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
    expect(headers["x-parent-session-id"]).toBe("sa-parent-1");
    // Sanity: the normal session header is still the child's own id.
    expect(headers["x-lore-session-id"]).toBe("sa-child-1");
  });

  test("primary session (no parentID) emits no x-parent-session-id", async () => {
    const dir = makeTmp("primary");
    const client = createMockClient({ parents: {} });
    const hooks = await initPlugin(dir, client);

    const headers = await headersFor(hooks, "primary-1");
    expect(headers["x-parent-session-id"]).toBeUndefined();
    expect(headers["x-lore-session-id"]).toBe("primary-1");
  });

  test("parent lookup is cached — session.get runs once across turns", async () => {
    const dir = makeTmp("cache");
    const calls: string[] = [];
    const client = createMockClient({
      parents: { "cache-child": "cache-parent" },
      calls,
    });
    const hooks = await initPlugin(dir, client);

    for (let i = 0; i < 3; i++) {
      const headers = await headersFor(hooks, "cache-child");
      expect(headers["x-parent-session-id"]).toBe("cache-parent");
    }
    expect(calls.filter((id) => id === "cache-child")).toHaveLength(1);
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

    // Turn 2: server recovers — the failure was not cached, so it resolves now.
    down = false;
    const h2 = await headersFor(hooks, "retry-child");
    expect(h2["x-parent-session-id"]).toBe("retry-parent");
  });
});
