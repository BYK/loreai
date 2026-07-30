/**
 * Auto-fallback tests for `lore import`: when the first credential candidate
 * 401s, the importer tries the next one automatically instead of surfacing the
 * error to the user. This addresses the Aditya scenario where his OpenCode
 * auth.json has multiple stale/fresh credentials across providers, and the
 * gateway's "first match" picker landed on the wrong one — without fallback,
 * the import would fail with an unhelpful credential-fix message.
 *
 * Tests in this file drive the REAL `commandImport` decision loop with
 * injected auth/history providers and a mocked LLM client. The first call
 * per candidate returns null + records an auth-rejected failure (mirrors the
 * adapter's real 401 path). The first candidate to return a valid answer
 * wins; if all fail, the diagnostic fires.
 *
 * Setup notes:
 *  - All tests use `anthropic` (built-in default model) + `openrouter` (no
 *    built-in default, requires explicit LORE_WORKER_MODEL). This combination
 *    lets us cover the fallback chain without the needsModel guard short-
 *    circuiting the test.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shutdownMock = vi.fn(async () => {});
let startConfig: Record<string, unknown> = {
  upstreamAnthropic: "https://api.anthropic.com",
  upstreamOpenAI: "https://api.openai.com",
};
vi.mock("../src/cli/start", () => ({
  startGateway: vi.fn(async () => ({
    config: startConfig,
    owned: true,
    shutdown: shutdownMock,
  })),
}));

// Capture every LLM client construction: [upstreams, getAuth, model, opts].
// `promptBehavior` controls what each prompt returns so we can simulate the
// "first candidate 401s, second succeeds" sequence without real network.
const llmClientCalls: unknown[][] = [];
let promptBehavior: () => Promise<string | null> = async () => "[]";
let promptCalls = 0;
vi.mock("../src/llm-adapter", () => ({
  createGatewayLLMClient: (...args: unknown[]) => {
    llmClientCalls.push(args);
    return {
      prompt: vi.fn(async () => {
        promptCalls++;
        return promptBehavior();
      }),
    };
  },
}));

import { commandImport } from "../src/cli/import";
import { _resetAuthForTest, setLastSeenAuth } from "../src/auth";
import {
  recordWorkerFailure,
  _resetForTest as _resetWorkerHealth,
} from "../src/worker-health";
import { _setModelDataForTest, clearModelDataCache } from "../src/worker-model";
import { load as loadConfig } from "@loreai/core";
import { conversationImport } from "@loreai/core";
import type { conversationImport as CI } from "@loreai/core";

const { registerProvider, clearProviders, getProviders } = conversationImport;
const { registerAuthProvider, clearAuthProviders, getAuthProviders } =
  conversationImport;

type FakeSpec = {
  name: string;
  displayName: string;
  messageCount?: number;
};

function fakeProvider(spec: FakeSpec): CI.AgentHistoryProvider {
  const messageCount = spec.messageCount ?? 5;
  return {
    name: spec.name,
    displayName: spec.displayName,
    detect(): CI.DetectedSession[] {
      return [
        {
          id: `${spec.name}-sess-1`,
          label: `2026-07-24 (${messageCount} messages)`,
          startedAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_001_000,
          estimatedTokens: 100,
          messageCount,
        } satisfies CI.DetectedSession,
      ];
    },
    readChunks(): CI.ConversationChunk[] {
      return [
        {
          label: `${spec.displayName} session (1 of 1)`,
          text: "[user] hello\n[assistant] hi there",
          estimatedTokens: 10,
          timestamp: 1_700_000_001_000,
        },
      ];
    },
  };
}

/**
 * Build a fake auth provider that returns the given credentials in order.
 * The chain tries them in returned order, so the FIRST credential is the one
 * tested first.
 */
function fakeAuthProvider(
  name: string,
  creds: CI.AgentResolvedAuth[],
): CI.AgentAuthProvider {
  return {
    name,
    readAuth(): CI.AgentResolvedAuth[] {
      return creds;
    },
  };
}

describe("commandImport — auto-fallback on 401 across credential candidates", () => {
  let project: string;
  let fakeHome: string;
  const logs: string[] = [];
  const errs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let realProviders: readonly CI.AgentHistoryProvider[];
  let realAuthProviders: readonly CI.AgentAuthProvider[];

  const prevHome = process.env.HOME;
  const prevXdgData = process.env.XDG_DATA_HOME;
  const prevXdgConfig = process.env.XDG_CONFIG_HOME;
  const prevWorkerModel = process.env.LORE_WORKER_MODEL;

  beforeEach(() => {
    delete process.env.LORE_REMOTE_URL; // force local mode
    delete process.env.LORE_WORKER_MODEL;
    _resetAuthForTest();
    _resetWorkerHealth();
    startConfig = {
      upstreamAnthropic: "https://api.anthropic.com",
      upstreamOpenAI: "https://api.openai.com",
    };
    project = mkdtempSync(join(tmpdir(), "lore-fb-project-"));
    fakeHome = mkdtempSync(join(tmpdir(), "lore-fb-home-"));
    process.env.HOME = fakeHome;
    process.env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
    process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");

    realProviders = [...getProviders()];
    clearProviders();
    realAuthProviders = [...getAuthProviders()];
    clearAuthProviders();

    logs.length = 0;
    errs.length = 0;
    llmClientCalls.length = 0;
    promptCalls = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
    });
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    shutdownMock.mockClear();
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    clearProviders();
    for (const p of realProviders) registerProvider(p);
    clearAuthProviders();
    for (const a of realAuthProviders) registerAuthProvider(a);
    _resetAuthForTest();
    _resetWorkerHealth();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevWorkerModel === undefined) delete process.env.LORE_WORKER_MODEL;
    else process.env.LORE_WORKER_MODEL = prevWorkerModel;
    await loadConfig(mkdtempSync(join(tmpdir(), "lore-fb-cfg-")));
  });

  const out = () => errs.join("\n");
  const info = () => logs.join("\n");

  test("first candidate 401s → second candidate succeeds (silent fallback)", async () => {
    // anthropic first (has built-in default model), openrouter second.
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        {
          scheme: "api-key",
          value: "sk-ant-stale",
          providerID: "anthropic",
        },
        {
          scheme: "api-key",
          value: "sk-or-fresh",
          providerID: "openrouter",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    // OpenRouter has no built-in default — explicitly set the worker model.
    process.env.LORE_WORKER_MODEL = "openrouter/anthropic/claude-sonnet-5";

    // First prompt: 401 (recordWorkerFailure + return null). Subsequent: success.
    let calls = 0;
    promptBehavior = async () => {
      calls++;
      if (calls === 1) {
        recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
        return null;
      }
      return "[]";
    };

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    // Exactly 2 LLM client constructions (one per candidate attempt).
    expect(llmClientCalls.length).toBe(2);
    const first = llmClientCalls[0]?.[2] as { providerID: string };
    const second = llmClientCalls[1]?.[2] as { providerID: string };
    expect(first.providerID).toBe("anthropic");
    expect(second.providerID).toBe("openrouter");

    // The user sees transparency lines, NOT the 401 diagnostic.
    expect(info()).toContain("Using on-disk auth.json: anthropic");
    expect(info()).toContain("Trying on-disk auth.json: openrouter");
    expect(info()).not.toContain("Can't import");
    expect(info()).toContain("anthropic rejected the credential");
  });

  test("BOTH candidates 401 → combined diagnostic with both providers named", async () => {
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        {
          scheme: "api-key",
          value: "sk-ant-stale",
          providerID: "anthropic",
        },
        {
          scheme: "api-key",
          value: "sk-or-stale",
          providerID: "openrouter",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    process.env.LORE_WORKER_MODEL = "openrouter/anthropic/claude-sonnet-5";

    promptBehavior = async () => {
      recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
      return null;
    };

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    expect(llmClientCalls.length).toBe(2);
    expect(out()).toContain("Can't import");
    expect(out()).toContain("anthropic");
    expect(out()).toContain("openrouter");
    expect(out()).toContain("rejected the credential");
    expect(out()).toContain("No provider auto-fallback could authenticate");
    // The shell env-vars remediation hint must include OPENROUTER_API_KEY
    // alongside the canonical anthropic/openai vars — users who have switched
    // to OpenRouter via env-only (no auth.json entry) need to see this as a
    // viable path. Aditya hit this gap after switching his default provider.
    expect(out()).toContain("OPENROUTER_API_KEY");
  });

  test("adm's 4-entry auth.json (anthropic + openai + openrouter + opencode) iterates all 3 default-model entries", async () => {
    // Regression test for adm's actual case (Slack 2026-07-30). His
    // ~/.local/share/opencode/auth.json had 4 entries — anthropic + openai
    // (both stale api-keys), openrouter (a live api-key), and a custom
    // `opencode` provider key. The original import log showed only the
    // first two being tried; the live openrouter entry was never reached.
    //
    // Before the per-credential default lookup (defaultSelectableModelForProvider)
    // the chain skipped openrouter/opencode because those providers have no
    // WORKER_DEFAULTS entry, even though they have valid keys. After the fix
    // each credential gets a per-provider default — openrouter is routed
    // against its cheapest selectable model in the cached models.dev data.
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        {
          scheme: "api-key",
          value: "sk-ant-stale-adm",
          providerID: "anthropic",
        },
        {
          scheme: "api-key",
          value: "sk-openai-stale-adm",
          providerID: "openai",
        },
        {
          scheme: "api-key",
          value: "sk-or-live-adm",
          providerID: "openrouter",
        },
        { scheme: "api-key", value: "sk-oc-adm", providerID: "opencode" },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    // Stub the models.dev cache so defaultSelectableModelForProvider can
    // pick a concrete model id for openrouter (no WORKER_DEFAULTS entry).
    // Anthropic defaults to claude-sonnet-5 via WORKER_DEFAULTS; openai
    // defaults to gpt-5.6-luna the same way. opencode (the literal provider
    // id from adm's auth.json) has no model in the snapshot → still skipped,
    // which is the correct fallback.
    _setModelDataForTest(
      {
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          family: "claude-sonnet",
          cost: { input: 2 },
        },
        "gpt-5.6-luna": {
          id: "gpt-5.6-luna",
          family: "gpt-luna",
          cost: { input: 1 },
        },
        "anthropic/claude-sonnet-4.5": {
          id: "anthropic/claude-sonnet-4.5",
          family: "claude-sonnet",
          cost: { input: 3 },
        },
      },
      undefined,
      {
        anthropic: ["claude-sonnet-5"],
        openai: ["gpt-5.6-luna"],
        openrouter: ["anthropic/claude-sonnet-4.5"],
      },
    );

    promptBehavior = async () => {
      recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
      return null;
    };

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    // anthropic + openai + openrouter all 401 (opencode is skipped — the
    // bare providerID `opencode` has no selectable worker model in the
    // cached snapshot). The chain MUST try openrouter before bailing so
    // adm's live key isn't silently ignored.
    const triedProviders = llmClientCalls.map((call) => {
      const model = call[2] as { providerID: string };
      return model.providerID;
    });
    expect(triedProviders).toContain("anthropic");
    expect(triedProviders).toContain("openai");
    expect(triedProviders).toContain("openrouter");
    expect(info()).toContain("Trying on-disk auth.json: openrouter");
    // Combined diagnostic names every provider the chain tried.
    expect(out()).toContain("anthropic");
    expect(out()).toContain("openai");
    expect(out()).toContain("openrouter");
    expect(out()).toContain("OPENROUTER_API_KEY");

    // Reset the cached model data so other tests aren't affected.
    clearModelDataCache();
  });

  test("cfg.model targeting openai routes through openrouter via same protocol", async () => {
    // Regression test for adm's actual case (Slack 2026-07-30, 2nd attempt):
    // his session model is `openai/gpt-5.6-luna` (from `cfg.model`) but his
    // only working credential is on openrouter. The chain must use the
    // openrouter credential with the SESSION model id (`gpt-5.6-luna`)
    // because openrouter proxies OpenAI-compatible requests — NOT pick a
    // random "cheapest model on openrouter" from models.dev (which might
    // be Anthropic-only on adm's account).
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        { scheme: "api-key", value: "sk-or-live", providerID: "openrouter" },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );

    // Set cfg.model via .lore.json so the chain picks it up via loadConfig.
    const lorePath = join(project, ".lore.json");
    writeFileSync(
      lorePath,
      JSON.stringify({
        model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      }),
    );
    await loadConfig(project);

    promptBehavior = async () => {
      recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
      return null;
    };

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    // The chain MUST route openrouter cred with session model id
    // `gpt-5.6-luna`, NOT some random openrouter-specific model.
    const openrouterCalls = llmClientCalls.filter((call) => {
      const model = call[2] as { providerID: string; modelID: string };
      return model.providerID === "openrouter";
    });
    expect(
      openrouterCalls.length,
      `expected openrouter call, got 0. info: ${info()}\nout: ${out()}\nllm calls: ${JSON.stringify(llmClientCalls.map((c) => c[2]))}`,
    ).toBeGreaterThan(0);
    for (const call of openrouterCalls) {
      const model = call[2] as { providerID: string; modelID: string };
      expect(model.modelID).toBe("gpt-5.6-luna");
    }
  });

  test("first candidate succeeds → no fallback attempted", async () => {
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        {
          scheme: "api-key",
          value: "sk-ant-fresh",
          providerID: "anthropic",
        },
        {
          scheme: "api-key",
          value: "sk-or-fresh",
          providerID: "openrouter",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    process.env.LORE_WORKER_MODEL = "openrouter/anthropic/claude-sonnet-5";

    promptBehavior = async () => "[]";

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    expect(llmClientCalls.length).toBe(1);
    const model = llmClientCalls[0]?.[2] as { providerID: string };
    expect(model.providerID).toBe("anthropic");
    expect(info()).not.toContain("Trying");
    expect(out()).not.toContain("Can't import");
  });

  test("env-credential takes over when on-disk candidates fail", async () => {
    // Use the REAL `opencode` agent name (so env capture runs) but with a
    // fake history provider and fake auth provider. anthropic on-disk
    // (default model), env anthropic with a DIFFERENT key — the chain tries
    // on-disk first (401s), falls through to env (succeeds).
    registerAuthProvider(
      fakeAuthProvider("opencode", [
        {
          scheme: "api-key",
          value: "sk-ant-stale",
          providerID: "anthropic",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode", displayName: "OpenCode" }),
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-fresh-env";

    let calls = 0;
    promptBehavior = async () => {
      calls++;
      if (calls === 1) {
        recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
        return null;
      }
      return "[]";
    };

    await commandImport([], { project, agent: "opencode", yes: true });

    expect(llmClientCalls.length).toBe(2);
    expect(info()).not.toContain("Can't import");
  });

  test("only one candidate available, it 401s → single-candidate diagnostic (no spurious fallback message)", async () => {
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        {
          scheme: "api-key",
          value: "sk-ant-stale",
          providerID: "anthropic",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );

    promptBehavior = async () => {
      recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
      return null;
    };

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    expect(llmClientCalls.length).toBe(1);
    expect(out()).toContain("Can't import");
    expect(out()).toContain("anthropic");
    expect(out()).toContain("rejected the credential");
    // Only one candidate → no fallback commentary.
    expect(out()).not.toContain("No provider auto-fallback could authenticate");
  });

  test("non-Pi/claude-code/codex/opencode agent with shell env credential → env credential enters chain", async () => {
    // Pi lacks an on-disk auth reader but DOES have `authTokenEnvVars` so
    // its env credential should be picked up by the chain. With a stale
    // on-disk key + fresh env key for a DIFFERENT provider, the chain
    // should iterate both candidates (de-dup by value lets them coexist).
    //
    // Use the real `claude-code` agent name (which has ANTHROPIC_AUTH_TOKEN
    // + ANTHROPIC_API_KEY) to verify the env-tier reaches the chain.
    registerAuthProvider(
      fakeAuthProvider("claude-code", [
        {
          scheme: "api-key",
          value: "sk-or-stale",
          providerID: "openrouter",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "claude-code", displayName: "Claude Code" }),
    );
    process.env.LORE_WORKER_MODEL = "openrouter/anthropic/claude-sonnet-5";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fresh-env";

    let calls = 0;
    promptBehavior = async () => {
      calls++;
      if (calls === 1) {
        recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
        return null;
      }
      return "[]";
    };

    await commandImport([], { project, agent: "claude-code", yes: true });

    // openrouter (on-disk) fails, then anthropic (env) succeeds.
    expect(llmClientCalls.length).toBe(2);
    const first = llmClientCalls[0]?.[2] as { providerID: string };
    const second = llmClientCalls[1]?.[2] as { providerID: string };
    expect(first.providerID).toBe("openrouter");
    expect(second.providerID).toBe("anthropic");
    expect(info()).toContain("ANTHROPIC_API_KEY");
    expect(info()).not.toContain("Can't import");
  });

  test("candidate 1 auth-rejected → candidate 2 transient null is NOT mis-attributed to auth (per-candidate probe snapshot)", async () => {
    // Regression test for Seer finding 15586850. Without per-candidate
    // `sinceMs` snapshotting, the lingering auth-rejected failure from
    // candidate 1 would trip the probe for candidate 2 when candidate 2
    // returns null on chunk 1 for non-auth reasons (network timeout, model
    // bug), causing the loop to abort candidate 2 with abortedByAuth=true
    // — wrongly skipping a potentially valid credential.
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        {
          scheme: "api-key",
          value: "sk-ant-stale",
          providerID: "anthropic",
        },
        {
          scheme: "api-key",
          value: "sk-or-fresh",
          providerID: "openrouter",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    process.env.LORE_WORKER_MODEL = "openrouter/anthropic/claude-sonnet-5";

    // Chunk-by-chunk behavior:
    //   call 1 → candidate 1 (anthropic), chunk 1: returns null +
    //     recordWorkerFailure (auth-rejected). Aborts that candidate.
    //   call 2 → candidate 2 (openrouter), chunk 1: returns null WITHOUT
    //     recording any failure — simulates a transient network error.
    //   call 3 → candidate 2, chunk 2: returns "[]" (success).
    // With per-candidate snapshot, call 2's null doesn't trip the probe
    // (no failure recorded since `attemptStartedAt`), so candidate 2
    // continues to chunk 2 and succeeds.
    // Without snapshot, call 2's null + probe seeing call 1's lingering
    // auth-rejected → wrongly marks candidate 2 as abortedByAuth=true.
    let calls = 0;
    promptBehavior = async () => {
      calls++;
      if (calls === 1) {
        recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
        return null;
      }
      if (calls === 2) {
        return null;
      }
      return "[]";
    };

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    // Both candidates ran. Candidate 2 reached chunk 2 and succeeded —
    // NOT aborted by candidate 1's lingering auth-rejected failure.
    expect(llmClientCalls.length).toBe(2);
    const second = llmClientCalls[1]?.[2] as { providerID: string };
    expect(second.providerID).toBe("openrouter");
    expect(info()).not.toContain("Can't import");
    // chunksAnswered for candidate 2 should be > 0 (chunk 2 succeeded),
    // NOT abortedByAuth.
    expect(info()).toContain("Trying on-disk auth.json: openrouter");
  });

  test("non-auth failure (no 401) → 'did not answer' message, NOT a credential-fix prompt", async () => {
    // The LLM returns null for non-auth reasons (network timeout, model bug,
    // etc.). abortedByAuth stays false, but chunksAnswered is also 0 so the
    // candidate fails the success predicate and falls through to the next.
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        {
          scheme: "api-key",
          value: "sk-ant-valid",
          providerID: "anthropic",
        },
        {
          scheme: "api-key",
          value: "sk-or-valid",
          providerID: "openrouter",
        },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    process.env.LORE_WORKER_MODEL = "openrouter/anthropic/claude-sonnet-5";

    // Every prompt: returns null WITHOUT recording auth-rejected (mirrors a
    // transient network/timeout failure rather than a 401).
    promptBehavior = async () => null;

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    expect(llmClientCalls.length).toBe(2);
    // Generic "did not answer" message — NOT the credential-fix remediation.
    // Only the FIRST candidate prints this (the LAST one has nothing to
    // fall through to). The full diagnostic still names every provider.
    expect(info()).toContain("anthropic did not answer");
    expect(info()).not.toContain("rejected the credential");
    // The full diagnostic also avoids the credential-fix advice when no
    // candidate was auth-rejected.
    expect(out()).toContain("none answered");
    expect(out()).toContain("transient network/timeout/model issue");
    expect(out()).not.toContain("export LORE_WORKER_API_KEY");
    expect(out()).not.toContain("opencode auth login");
  });

  test("tier-4 last-seen session credential for defaultless provider → needsModel signal (workerApiKey unset)", async () => {
    // Regression test for Seer finding 15586978/1 (and the prior
    // 15586423). Tier-4 in resolveAgentImportAuth used to return
    // {getAuth, model} with empty modelID for defaultless providers like
    // openrouter, which let commandImport proceed to an LLM call with
    // model="" → upstream 400. After the fix, tier-4 returns
    // {needsModel: providerID} for parity with tiers 2 and 3, so the
    // user gets a clear "set a worker model" message instead.
    //
    // Setup: only a last-seen session credential for openrouter (no
    // default worker model). No on-disk creds, no env. Expect the
    // per-agent skip line to surface the needsModel signal directly.
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", []), // no on-disk creds at all
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    // Inject a last-seen session credential for openrouter (no default
    // model — tier-4 now signals needsModel directly).
    setLastSeenAuth({ scheme: "bearer", value: "sk-or-session" }, "openrouter");

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    // Should NOT have built an LLM client (needsModel signal short-circuits
    // before the LLM client is constructed).
    expect(llmClientCalls.length).toBe(0);
    // Per-agent skip line shows the needsModel message with the provider
    // name and a "Set one and retry" pointer to the guidance below.
    expect(info()).toContain("found your openrouter credential");
    expect(info()).toContain("no worker model is set for that provider");
    // End-of-run guidance fires once for the collected needsModel providers.
    expect(out()).toContain("worker model");
  });

  test("all candidates 401 → totalFailed counts ATTEMPTED chunks, not all chunks (1 per candidate)", async () => {
    // Regression test for Seer finding 15586978/0. The summary report
    // used to inflate the failure count by `chunks.length` (e.g. 70)
    // even though the worker-health probe aborts after the FIRST chunk
    // of each candidate (so only N candidates were actually attempted).
    // User saw "70 failed" for an agent with 70 chunks + 2 candidates.
    registerAuthProvider(
      fakeAuthProvider("opencode-fake", [
        { scheme: "api-key", value: "sk-ant-broken", providerID: "anthropic" },
        { scheme: "api-key", value: "sk-or-broken", providerID: "openrouter" },
      ]),
    );
    registerProvider(
      fakeProvider({ name: "opencode-fake", displayName: "OpenCode" }),
    );
    process.env.LORE_WORKER_MODEL = "openrouter/anthropic/claude-sonnet-5";

    promptBehavior = async () => {
      recordWorkerFailure("_unknown", "lore-import", "auth-rejected");
      return null;
    };

    await commandImport([], { project, agent: "opencode-fake", yes: true });

    // 2 candidates × N chunks each = the probe aborts after 1 chunk
    // per candidate, so llmClientCalls.length === 2 (one per candidate).
    expect(llmClientCalls.length).toBe(2);
    // The failure summary line should report `N chunks failed` where N
    // equals the number of candidates, NOT chunks.length. (We use a
    // single-chunk fixture so this is also == 2.)
    expect(info()).toContain("2 chunks failed");
  });
});
