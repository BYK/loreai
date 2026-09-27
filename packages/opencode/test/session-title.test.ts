/**
 * OpenCode session title forwarding (#1921).
 *
 * The harness's own `Session.title` is resolved alongside parentID in the
 * `chat.headers` hook and forwarded percent-encoded as `x-lore-session-title`
 * so the gateway can persist it as the session's explicit title. OpenCode's
 * auto "New session" placeholder is suppressed and polled until a real title
 * appears; a harness that reports no title is never re-queried.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, describe, expect, test } from "vitest";
import { LorePlugin } from "../src/index";

interface MockOpts {
  parents?: Record<string, string>;
  /** session id → title session.get should report. Absent ⇒ no title field. */
  titles?: Record<string, string>;
  calls?: string[];
}

function createMockClient(opts: MockOpts): PluginInput["client"] {
  return {
    tui: { showToast: () => Promise.resolve() },
    session: {
      get: (args: { path: { id: string } }) => {
        const id = args?.path?.id;
        opts.calls?.push(id);
        const parentID = opts.parents?.[id];
        const title = opts.titles?.[id];
        return Promise.resolve({
          data: {
            id,
            ...(parentID ? { parentID } : {}),
            ...(title !== undefined ? { title } : {}),
          },
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

describe("OpenCode plugin — session title forwarding (#1921)", () => {
  let tmpDirs: string[] = [];
  function makeTmp(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lore-title-${label}-`));
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

  test("forwards the session title percent-encoded", async () => {
    const client = createMockClient({
      titles: { s1: "Fix the Ünïcode bug" },
    });
    const hooks = await initPlugin(makeTmp("enc"), client);
    const headers = await headersFor(hooks, "s1");
    expect(headers["x-lore-session-title"]).toBe(
      "Fix%20the%20%C3%9Cn%C3%AFcode%20bug",
    );
  });

  test("placeholder title is not forwarded and is re-queried next turn", async () => {
    const calls: string[] = [];
    const titles: Record<string, string> = { ph: "New session - 2026-09-27" };
    const client = createMockClient({ titles, calls });
    const hooks = await initPlugin(makeTmp("ph"), client);

    const first = await headersFor(hooks, "ph");
    expect(first["x-lore-session-title"]).toBeUndefined();
    // Placeholder is kept but polled: the real title may land any turn.
    titles.ph = "Investigate FTS tokenizer";
    const second = await headersFor(hooks, "ph");
    expect(calls).toEqual(["ph", "ph"]);
    expect(second["x-lore-session-title"]).toBe(
      "Investigate%20FTS%20tokenizer",
    );
  });

  test("a real title is cached — session.get runs once across turns", async () => {
    const calls: string[] = [];
    const client = createMockClient({
      titles: { real: "Refactor the sync outbox" },
      calls,
    });
    const hooks = await initPlugin(makeTmp("real"), client);
    await headersFor(hooks, "real");
    const again = await headersFor(hooks, "real");
    expect(calls).toEqual(["real"]);
    expect(again["x-lore-session-title"]).toBe(
      "Refactor%20the%20sync%20outbox",
    );
  });

  test("a session with no title emits no header and is not re-queried", async () => {
    const calls: string[] = [];
    const client = createMockClient({ calls });
    const hooks = await initPlugin(makeTmp("none"), client);
    const first = await headersFor(hooks, "none");
    const second = await headersFor(hooks, "none");
    expect(first["x-lore-session-title"]).toBeUndefined();
    expect(second["x-lore-session-title"]).toBeUndefined();
    expect(calls).toEqual(["none"]);
  });
});
