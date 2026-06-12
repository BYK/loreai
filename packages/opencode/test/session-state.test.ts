/**
 * Tests for per-project state in the OpenCode plugin (B2).
 *
 * The plugin function (`LorePlugin`) can be called multiple times in the
 * same process — e.g., when the user has multiple OpenCode worktrees open
 * in parallel, or when a sub-agent spawns a new project context. The
 * per-project Map ensures that:
 *   - Each project gets its own registered project path + git remote
 *   - The `chat.headers` hook injects the right headers per request
 *   - Concurrent project registrations don't clobber each other
 *
 * Regression coverage for the "lore-config" bug variant where the module-
 * level `currentProjectPath` global was overwritten by sibling project
 * inits, causing requests to be misattributed.
 */
import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LorePlugin } from "../src/index";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

function createMockClient() {
  return {
    tui: { showToast: () => Promise.resolve() },
    session: {
      get: () => Promise.resolve({ data: {} }),
      list: () => Promise.resolve({ data: [] }),
      create: () => Promise.resolve({ data: { id: "worker_1" } }),
      messages: () => Promise.resolve({ data: [] }),
      message: () => Promise.resolve({ data: null }),
      prompt: () => Promise.resolve({ data: {} }),
    },
  } as unknown as PluginInput["client"];
}

/**
 * Initialize the plugin with a mock client, given a project id and
 * working directory. The plugin's `chat.headers` hook is the system
 * under test — we want to verify it injects the right project path for
 * each project.
 */
async function initPluginForProject(
  projectId: string,
  directory: string,
  worktree?: string,
) {
  const client = createMockClient();
  const hooks = await LorePlugin({
    client,
    project: { id: projectId } as unknown as PluginInput["project"],
    directory,
    worktree: worktree ?? directory,
    serverUrl: new URL("http://localhost:0"),
    $: {} as unknown as PluginInput["$"],
  } as PluginInput);
  return hooks;
}

/**
 * Build a minimal `chat.headers` input — matches the shape OpenCode
 * passes to the hook. Provider is optional; when present, the hook should
 * set x-lore-provider.
 */
type ChatHeadersHook = NonNullable<Hooks["chat.headers"]>;
type ChatHeadersInput = Parameters<ChatHeadersHook>[0];
type ChatHeadersOutput = Parameters<ChatHeadersHook>[1];

function buildChatHeadersInput(
  sessionID: string,
  agent: string,
  providerID?: string,
): {
  input: ChatHeadersInput;
  output: ChatHeadersOutput;
} {
  const input = {
    sessionID,
    agent,
    model: {
      providerID: providerID ?? "anthropic",
      modelID: "claude-3-5-sonnet",
    },
    provider: providerID ? { id: providerID } : undefined,
    message: { id: "msg-1" },
  } as unknown as ChatHeadersInput;
  const output = { headers: {} as Record<string, string> } as ChatHeadersOutput;
  return { input, output };
}

describe("OpenCode plugin — per-project state (B2)", () => {
  let tmpDirs: string[] = [];

  function makeTmp(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lore-opencode-test-${label}-`));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  test("single project: chat.headers injects x-lore-project for that project", async () => {
    const dirA = makeTmp("a");
    const hooks = await initPluginForProject("project-a", dirA);

    const { input, output } = buildChatHeadersInput("session-1", "coder");
    await hooks["chat.headers"]?.(input, output);

    expect(output.headers["x-lore-session-id"]).toBe("session-1");
    expect(output.headers["x-lore-agent"]).toBe("coder");
    expect(output.headers["x-lore-project"]).toBe(dirA);
  });

  test("two projects: each chat.headers call injects ITS project's path", async () => {
    const dirA = makeTmp("a");
    const dirB = makeTmp("b");
    const hooksA = await initPluginForProject("project-a", dirA);
    // Second project — re-uses the same plugin module (simulating two
    // OpenCode worktrees in the same process).
    const hooksB = await initPluginForProject("project-b", dirB);

    // Request from project A
    const inputA = buildChatHeadersInput("session-a", "coder").input;
    const outputA = { headers: {} as Record<string, string> };
    await hooksA["chat.headers"]?.(inputA, outputA);
    expect(outputA.headers["x-lore-project"]).toBe(dirA);

    // Request from project B (different plugin instance, but the underlying
    // module-level state is shared — verify it doesn't leak)
    const inputB = buildChatHeadersInput("session-b", "coder").input;
    const outputB = { headers: {} as Record<string, string> };
    await hooksB["chat.headers"]?.(inputB, outputB);
    expect(outputB.headers["x-lore-project"]).toBe(dirB);

    // Cross-check: A's project path is still correct after B's hook ran
    const outputA2 = { headers: {} as Record<string, string> };
    await hooksA["chat.headers"]?.(
      buildChatHeadersInput("session-a-2", "coder").input,
      outputA2,
    );
    expect(outputA2.headers["x-lore-project"]).toBe(dirA);
  });

  test("multiple sessions in the same project all get the same project path", async () => {
    const dirA = makeTmp("a");
    const hooks = await initPluginForProject("project-a", dirA);

    for (const sessionID of ["s1", "s2", "s3", "sub-agent-1", "sub-agent-2"]) {
      const { input, output } = buildChatHeadersInput(sessionID, "coder");
      await hooks["chat.headers"]?.(input, output);
      expect(output.headers["x-lore-project"]).toBe(dirA);
    }
  });

  test("meta agent requests still get x-lore-project (so gateway can route consistently)", async () => {
    const dirA = makeTmp("a");
    const hooks = await initPluginForProject("project-a", dirA);

    // Simulate Claude Code's haiku side-channel / title generation
    // sub-agent by using a "title" agent name. The chat.headers hook
    // should still set the project path so the gateway doesn't fall back
    // to cwd on these requests.
    const { input, output } = buildChatHeadersInput("session-meta", "title");
    await hooks["chat.headers"]?.(input, output);

    expect(output.headers["x-lore-project"]).toBe(dirA);
  });

  test("a non-git project never emits x-lore-git-remote (no sibling leak)", async () => {
    // Regression for the "git-remote magnet": a project in a non-repo dir must
    // not carry a git remote — neither its own (none on disk) nor one leaked
    // from a sibling project. The temp dirs are not git repos, so getGitRemote
    // returns null and the header must be absent.
    const dirA = makeTmp("a"); // not a git repo
    const dirB = makeTmp("b"); // not a git repo

    const hooksB = await initPluginForProject("project-b", dirB);
    const hooksA = await initPluginForProject("project-a", dirA);

    const { input, output } = buildChatHeadersInput("session-a", "coder");
    await hooksA["chat.headers"]?.(input, output);

    expect(output.headers["x-lore-project"]).toBe(dirA);
    // No remote on a non-repo dir, and none leaked from project B.
    expect(output.headers["x-lore-git-remote"]).toBeUndefined();

    // And project B (initialized earlier) likewise carries no remote.
    const { input: inB, output: outB } = buildChatHeadersInput(
      "session-b",
      "coder",
    );
    await hooksB["chat.headers"]?.(inB, outB);
    expect(outB.headers["x-lore-git-remote"]).toBeUndefined();
  });
});
