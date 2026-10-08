import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentImportAuth } from "../src/cli/import";
import {
  resolveExtractionUpstreams,
  buildNeedsModelGuidance,
} from "../src/cli/import";
import { workerKeyScheme } from "../src/auth";

type ImportAuth = NonNullable<ReturnType<typeof resolveAgentImportAuth>>;
type UsableAuth = Extract<ImportAuth, { getAuth: unknown }>;

/**
 * Assert the result is a usable auth (not null and not the `needsModel`
 * signal) and return it narrowed, so tests can access model/getAuth/upstream.
 */
function usable(res: ImportAuth | null): UsableAuth {
  expect(res).not.toBeNull();
  expect(res).not.toHaveProperty("needsModel");
  return res as UsableAuth;
}

let tmp: string;
const originalCwd = process.cwd();
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeOpenCodeAuth(data: unknown): void {
  const dir = join(process.env.XDG_DATA_HOME as string, "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(data), "utf8");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lore-importauth-"));
  setEnv("HOME", tmp);
  setEnv("XDG_DATA_HOME", join(tmp, ".local", "share"));
  setEnv("XDG_CONFIG_HOME", join(tmp, ".config"));
  // Active-provider lookup gives project config precedence over XDG config.
  // Run each case in its disposable project so repository-level config cannot
  // leak into this suite's isolated OpenCode fixture.
  process.chdir(tmp);
  // Clear agent env credentials so each test starts from a known state
  // (the runner's own shell may have these set).
  setEnv("ANTHROPIC_BASE_URL", undefined);
  setEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  setEnv("ANTHROPIC_API_KEY", undefined);
  setEnv("OPENAI_BASE_URL", undefined);
  setEnv("OPENAI_API_KEY", undefined);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  for (const k of Object.keys(saved)) delete saved[k];
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveAgentImportAuth", () => {
  test("worker key wins over harness auth; provider from cfg.model", () => {
    writeOpenCodeAuth({ openrouter: { type: "api", key: "disk-key" } });
    const res = resolveAgentImportAuth("opencode", "worker-key-123", {
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    });
    const ok = usable(res);
    expect(ok.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    });
    const cred = ok.getAuth(undefined, "openai");
    expect(cred).toEqual({
      scheme: workerKeyScheme("openai"),
      value: "worker-key-123",
    });
  });

  test("worker key with no cfg.model defaults provider to anthropic", () => {
    const res = resolveAgentImportAuth("opencode", "wk", undefined);
    const ok = usable(res);
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.getAuth(undefined, undefined)).toEqual({
      scheme: "api-key",
      value: "wk",
    });
  });

  test("harness on-disk api-key is used when no worker key", () => {
    // anthropic HAS a WORKER_DEFAULTS entry, so the stored key resolves to a
    // usable credential with a concrete model even with no cfgModel.
    writeOpenCodeAuth({ anthropic: { type: "api", key: "sk-ant-xyz" } });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    const ok = usable(res);
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.model.modelID).toBeTruthy(); // real default, never empty
    expect(ok.getAuth()).toEqual({ scheme: "api-key", value: "sk-ant-xyz" });
  });

  test("on-disk key for a routable-but-defaultless provider + no model → needsModel (never an empty-model 400)", () => {
    // openrouter is routable (has a route URL) but has NO WORKER_DEFAULTS entry,
    // and OpenCode's auth.json stores only the key (no modelID hint). Tier 2
    // must signal needsModel rather than return {modelID:""} → silent 400.
    writeOpenCodeAuth({ openrouter: { type: "api", key: "sk-or-xyz" } });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    expect(res).toEqual({ needsModel: "openrouter" });
  });

  test("on-disk key for a defaultless provider IS usable with a same-provider cfgModel", () => {
    // The escape hatch: a matching LORE_WORKER_MODEL supplies the model tier 2
    // otherwise lacks, so the openrouter key becomes usable.
    writeOpenCodeAuth({ openrouter: { type: "api", key: "sk-or-xyz" } });
    const ok = usable(
      resolveAgentImportAuth("opencode", undefined, {
        providerID: "openrouter",
        modelID: "openrouter/some-model",
      }),
    );
    expect(ok.model).toEqual({
      providerID: "openrouter",
      modelID: "openrouter/some-model",
    });
    expect(ok.getAuth()).toEqual({ scheme: "api-key", value: "sk-or-xyz" });
  });

  test("skips harness credential for a provider Lore does not proxy", () => {
    // "nonexistent-provider" is not in PROVIDER_ROUTES → not routable → skipped.
    writeOpenCodeAuth({
      "nonexistent-provider": { type: "api", key: "unusable" },
    });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    expect(res).toBeNull();
  });

  test("skips a routable provider whose route has no upstream URL (e.g. ollama)", () => {
    // ollama IS in PROVIDER_ROUTES but with url:null — not directly usable for
    // extraction, so it must fall through to guidance, not a doomed call.
    writeOpenCodeAuth({ ollama: { type: "api", key: "local-key" } });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    expect(res).toBeNull();
  });

  test("resolves a github-copilot credential (bearer, no token exchange)", () => {
    // OpenCode's github-copilot GitHub OAuth token works directly as a Bearer
    // against api.githubcopilot.com (route has a concrete url) — it must NOT be
    // skipped. The refresh field is preferred and expires:0 is not "expired".
    writeOpenCodeAuth({
      "github-copilot": {
        type: "oauth",
        access: "gho_access",
        refresh: "gho_refresh",
        expires: 0,
      },
    });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    const ok = usable(res);
    expect(ok.model.providerID).toBe("github-copilot");
    expect(ok.getAuth()).toEqual({
      scheme: "bearer",
      value: "gho_refresh",
    });
  });

  test("prefers a routable credential over an unroutable earlier one", () => {
    writeOpenCodeAuth({
      "nonexistent-provider": { type: "api", key: "skip-me" },
      anthropic: { type: "api", key: "use-me" },
    });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    const ok = usable(res);
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.getAuth()).toEqual({ scheme: "api-key", value: "use-me" });
  });

  test("on-disk credential honors an explicit same-provider cfgModel (LORE_WORKER_MODEL override) — Kjaer Copilot case", () => {
    // github-copilot on-disk token, but the user set LORE_WORKER_MODEL to a
    // model their Copilot plan actually serves (the default gpt-5-mini may be
    // unavailable). The explicit model must win over the built-in default.
    writeOpenCodeAuth({
      "github-copilot": {
        type: "oauth",
        access: "gho_access",
        refresh: "gho_refresh",
        expires: 0,
      },
    });
    const res = resolveAgentImportAuth("opencode", undefined, {
      providerID: "github-copilot",
      modelID: "claude-sonnet-5",
    });
    const ok = usable(res);
    expect(ok.model).toEqual({
      providerID: "github-copilot",
      modelID: "claude-sonnet-5",
    });
    // Still uses the on-disk credential (tier 2), not a worker key.
    expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "gho_refresh" });
  });

  test("on-disk credential ignores a cfgModel for a DIFFERENT provider (keeps its own provider's default)", () => {
    writeOpenCodeAuth({
      "github-copilot": {
        type: "oauth",
        access: "gho_access",
        refresh: "gho_refresh",
        expires: 0,
      },
    });
    // cfgModel targets anthropic, but the credential is github-copilot → the
    // override must NOT apply (it'd route a copilot token to an anthropic model).
    const res = resolveAgentImportAuth("opencode", undefined, {
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    });
    const ok = usable(res);
    expect(ok.model.providerID).toBe("github-copilot");
    expect(ok.model.modelID).toBe("gpt-5-mini"); // copilot default, not the anthropic override
  });

  test("returns null when the agent has no on-disk auth and no worker key", () => {
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    expect(res).toBeNull();
  });

  test("uses resolved credential's own model hint when provided", () => {
    // pi reader emits no modelID; opencode emits none either — but a bearer
    // oauth entry for a routable provider still resolves to the default model.
    writeOpenCodeAuth({ anthropic: { type: "api", key: "sk-ant" } });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    const ok = usable(res);
    expect(ok.model.providerID).toBe("anthropic");
    // default model for anthropic
    expect(ok.model.modelID).toBe("claude-sonnet-5");
  });
});

describe("resolveAgentImportAuth — harness env credential (tier 3)", () => {
  // OpenRouter has no built-in default worker model, so callers must supply a
  // model (LORE_WORKER_MODEL / .lore.json). Simulate that with cfgModel.
  const orModel = {
    providerID: "openrouter",
    modelID: "openrouter/gpt-5-mini",
  };

  test("Claude Code via ANTHROPIC_BASE_URL=openrouter + ANTHROPIC_AUTH_TOKEN (bearer) — the OpenRouter setup", () => {
    // Fresh tmp HOME → no on-disk claude auth, so the env credential is used.
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-or-live");
    const ok = usable(
      resolveAgentImportAuth("claude-code", undefined, orModel),
    );
    expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "sk-or-live" });
    // cfgModel is honored for the (defaultless) openrouter provider.
    expect(ok.model).toEqual(orModel);
    // Extraction is routed to the captured upstream.
    expect(ok.upstream).toBe("https://openrouter.ai/api");
  });

  test("env credential for a provider with NO default model + no cfgModel → needsModel signal (not a silent empty-model 400)", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-or-live");
    const res = resolveAgentImportAuth("claude-code", undefined, undefined);
    expect(res).toEqual({ needsModel: "openrouter" });
  });

  test("ANTHROPIC_AUTH_TOKEN (bearer) wins over ANTHROPIC_API_KEY (api-key)", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-or-bearer");
    setEnv("ANTHROPIC_API_KEY", "sk-apikey");
    const ok = usable(
      resolveAgentImportAuth("claude-code", undefined, orModel),
    );
    expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "sk-or-bearer" });
  });

  test("ANTHROPIC_API_KEY (api-key) used when no auth token", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_API_KEY", "sk-apikey");
    const ok = usable(
      resolveAgentImportAuth("claude-code", undefined, orModel),
    );
    expect(ok.getAuth()).toEqual({ scheme: "api-key", value: "sk-apikey" });
  });

  test("token with no base URL falls back to the agent's wire-protocol provider (anthropic has a default model), no upstream", () => {
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-tok");
    const ok = usable(
      resolveAgentImportAuth("claude-code", undefined, undefined),
    );
    expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "sk-tok" });
    expect(ok.model.providerID).toBe("anthropic"); // wireProtocol fallback
    expect(ok.model.modelID).toBeTruthy(); // anthropic HAS a default model
    expect(ok.upstream).toBeUndefined();
  });

  test("unknown-host base URL routes extraction there; provider defaults to wire protocol (anthropic → has default model)", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://llm.corp.internal");
    setEnv("ANTHROPIC_AUTH_TOKEN", "corp-tok");
    const ok = usable(
      resolveAgentImportAuth("claude-code", undefined, undefined),
    );
    expect(ok.upstream).toBe("https://llm.corp.internal");
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "corp-tok" });
  });

  test("env credential ignores a cfgModel for a DIFFERENT provider (same guard as tier 2) — Seer #15446146", () => {
    // Env points the agent at OpenRouter, but the user's LORE_WORKER_MODEL names
    // a github-copilot model. Applying it would route the OpenRouter key to a
    // copilot model → cross-provider mismatch. The override must be ignored and
    // fall back to the captured provider's default (openrouter has none →
    // needsModel), NOT silently used.
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-or-live");
    const res = resolveAgentImportAuth("claude-code", undefined, {
      providerID: "github-copilot",
      modelID: "claude-sonnet-5",
    });
    // openrouter has no default model and the mismatched cfgModel is ignored.
    expect(res).toEqual({ needsModel: "openrouter" });
  });

  test("env credential honors a cfgModel for the SAME (captured) provider", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-or-live");
    const ok = usable(
      resolveAgentImportAuth("claude-code", undefined, {
        providerID: "openrouter",
        modelID: "openrouter/some-model",
      }),
    );
    expect(ok.model).toEqual({
      providerID: "openrouter",
      modelID: "openrouter/some-model",
    });
    expect(ok.upstream).toBe("https://openrouter.ai/api");
  });

  test("on-disk auth (tier 2) takes precedence over env credential (tier 3)", () => {
    // opencode has on-disk auth AND we set an env token — but opencode has no
    // authTokenEnvVars, so only tier 2 applies. Use claude-code with BOTH a
    // stored credential and env vars to prove ordering.
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "disk-oauth", expiresAt: null },
      }),
      "utf8",
    );
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_AUTH_TOKEN", "env-token");
    const ok = usable(
      resolveAgentImportAuth("claude-code", undefined, undefined),
    );
    // Tier 2 (on-disk) wins: provider anthropic, not openrouter; no upstream.
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.getAuth()?.value).toBe("disk-oauth");
    expect(ok.upstream).toBeUndefined();
  });

  test("worker key (tier 1) takes precedence over env credential (tier 3)", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    setEnv("ANTHROPIC_AUTH_TOKEN", "env-token");
    const ok = usable(
      resolveAgentImportAuth("claude-code", "sk-ant-worker", undefined),
    );
    expect(ok.getAuth(undefined, "anthropic")?.value).toBe("sk-ant-worker");
    expect(ok.upstream).toBeUndefined();
  });

  test("no token and no on-disk auth → null (unchanged behavior)", () => {
    setEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
    const res = resolveAgentImportAuth("claude-code", undefined, undefined);
    expect(res).toBeNull();
  });
});

describe("resolveExtractionUpstreams", () => {
  const defaults = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  test("captured env upstream routes BOTH protocol slots at it", () => {
    expect(
      resolveExtractionUpstreams(
        "https://openrouter.ai/api",
        undefined,
        defaults,
      ),
    ).toEqual({
      anthropic: "https://openrouter.ai/api",
      openai: "https://openrouter.ai/api",
    });
  });

  test("explicit LORE_WORKER_UPSTREAM (configWorkerUpstream) beats the env upstream", () => {
    // A user-set dedicated worker upstream always wins — we keep the defaults
    // map (which the caller already pointed at config.workerUpstream).
    expect(
      resolveExtractionUpstreams(
        "https://openrouter.ai/api",
        "https://proxy.example/v1",
        defaults,
      ),
    ).toEqual(defaults);
  });

  test("no captured upstream → defaults unchanged", () => {
    expect(resolveExtractionUpstreams(undefined, undefined, defaults)).toEqual(
      defaults,
    );
  });
});

describe("buildNeedsModelGuidance", () => {
  test("no providers → null (nothing to say)", () => {
    expect(buildNeedsModelGuidance([], false)).toBeNull();
    expect(buildNeedsModelGuidance([], true)).toBeNull();
  });

  test("single provider, nothing else authenticated → full guidance, no 'some agents'", () => {
    const msg = buildNeedsModelGuidance(["openrouter"], false);
    expect(msg).toContain("Can't import:");
    expect(msg).not.toContain("some agents");
    expect(msg).toContain("export LORE_WORKER_MODEL=openrouter/<model>");
  });

  test("partial success (some agents authed) → guidance STILL produced, worded 'some agents' — Seer #15456784", () => {
    // The whole point: a needsModel failure must surface guidance even when
    // OTHER agents succeeded, because the per-agent skip line promised it.
    const msg = buildNeedsModelGuidance(["openrouter"], true);
    expect(msg).not.toBeNull();
    expect(msg).toContain("some agents");
    expect(msg).toContain("export LORE_WORKER_MODEL=openrouter/<model>");
  });

  test("multiple providers → one export line each; plural wording", () => {
    const msg = buildNeedsModelGuidance(["openrouter", "deepseek"], false);
    expect(msg).toContain("export LORE_WORKER_MODEL=openrouter/<model>");
    expect(msg).toContain("export LORE_WORKER_MODEL=deepseek/<model>");
    expect(msg).toContain("those providers");
    expect(msg).toContain("openrouter, deepseek");
  });
});

describe("resolveAgentImportAuth — OpenCode env-vs-disk preference (active provider)", () => {
  // The user's #1 complaint: `lore import` was 401-storming on a stale
  // auth.json key because it didn't match what OpenCode ACTUALLY uses today.
  // Two coordinated fixes:
  //   (a) readUsableAuth reorders auth.json entries so the user's CURRENTLY
  //       CONFIGURED provider (per opencode.json's `model`/`small_model`)
  //       comes first. Without (a), the importer picks whichever entry was
  //       first in JSON-iteration order — typically the oldest.
  //   (b) For OpenCode specifically, a shell-env credential for the active
  //       provider wins over the on-disk credential for that provider —
  //       matches OpenCode's own env-first precedence in its @ai-sdk clients.
  //       Without (b), a user with ANTHROPIC_API_KEY set + a stale
  //       `anthropic: { key }` in auth.json gets 401-stormed even though
  //       `lore run opencode` succeeds (because OpenCode reads the env var,
  //       not auth.json).

  function writeOpenCodeConfig(cfg: unknown): void {
    const dir = join(process.env.XDG_CONFIG_HOME as string, "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), JSON.stringify(cfg), "utf8");
  }

  test("(a) auth.json has both stale anthropic + current openrouter; opencode.json model=openrouter → openrouter wins", () => {
    writeOpenCodeAuth({
      anthropic: { type: "api", key: "sk-ant-stale" },
      openrouter: { type: "api", key: "sk-or-current" },
    });
    writeOpenCodeConfig({ model: "openrouter/anthropic/claude-sonnet-5" });
    // The active-provider reorder pins openrouter first, but openrouter has
    // no default worker model → the result is the needsModel signal, which
    // still names the CORRECT (active) provider. If the reorder regressed,
    // anthropic would be picked — that has a default model — and the test
    // would see a usable credential for anthropic instead.
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    expect(res).toEqual({ needsModel: "openrouter" });
  });

  test("(b) ANTHROPIC_API_KEY set + stale anthropic in auth.json + opencode.json model=anthropic → env wins", () => {
    // The user has ANTHROPIC_API_KEY in their shell (the key OpenCode's
    // Anthropic SDK actually uses) + an old `anthropic: { key }` left over
    // from a previous config. Tier-2 on-disk would pick the stale key and
    // 401-storm; the env preference MUST route to the env credential.
    writeOpenCodeAuth({ anthropic: { type: "api", key: "sk-ant-stale" } });
    writeOpenCodeConfig({ model: "anthropic/claude-sonnet-5" });
    setEnv("ANTHROPIC_API_KEY", "sk-ant-env-fresh");
    // The env credential wins: returned value is the env-var key, not the
    // on-disk one. The model uses anthropic's default (anthropic has a
    // default), so we get a usable auth (not needsModel).
    const ok = usable(resolveAgentImportAuth("opencode", undefined, undefined));
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.getAuth()).toEqual({
      scheme: "api-key",
      value: "sk-ant-env-fresh",
    });
  });

  test("(b) ANTHROPIC_API_KEY set but opencode.json points elsewhere → on-disk wins (env does NOT auto-override other providers)", () => {
    // The env preference is scoped to the ACTIVE provider — a stray
    // ANTHROPIC_API_KEY in the shell must NOT be used when the user is
    // actually running openrouter. This would route the wrong key to the
    // wrong provider. openrouter has no default model → needsModel.
    writeOpenCodeAuth({ openrouter: { type: "api", key: "sk-or-only" } });
    writeOpenCodeConfig({ model: "openrouter/some/model" });
    setEnv("ANTHROPIC_API_KEY", "sk-ant-unused");
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    // needsModel names openrouter — proving the env did NOT leak into the
    // credential. If the env had been used, we'd see anthropic routing.
    expect(res).toEqual({ needsModel: "openrouter" });
  });

  test("env credential with NO on-disk fallback is still picked up via tier 3 (e.g. fresh machine, never ran `opencode auth login`)", () => {
    writeOpenCodeAuth({}); // no on-disk credentials
    writeOpenCodeConfig({ model: "anthropic/claude-sonnet-5" });
    setEnv("ANTHROPIC_API_KEY", "sk-ant-only-env");
    const ok = usable(resolveAgentImportAuth("opencode", undefined, undefined));
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.getAuth()).toEqual({
      scheme: "api-key",
      value: "sk-ant-only-env",
    });
  });

  test("ANTHROPIC_AUTH_TOKEN (bearer) wins over ANTHROPIC_API_KEY (api-key) — matches Claude Code precedence parity", () => {
    writeOpenCodeConfig({ model: "anthropic/claude-sonnet-5" });
    setEnv("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat-env");
    setEnv("ANTHROPIC_API_KEY", "sk-ant-apikey-env");
    const ok = usable(resolveAgentImportAuth("opencode", undefined, undefined));
    expect(ok.getAuth()).toEqual({
      scheme: "bearer",
      value: "sk-ant-oat-env",
    });
  });

  test("(a)+(b) combined: stale anthropic on-disk + fresh ANTHROPIC_API_KEY in shell + opencode.json model=anthropic → env wins", () => {
    // End-to-end smoke for the original user complaint. Without these
    // fixes, the importer picks `sk-ant-stale` from auth.json and
    // 401-storms; with them, it picks `sk-ant-fresh` from the shell and
    // routes successfully.
    writeOpenCodeAuth({ anthropic: { type: "api", key: "sk-ant-stale" } });
    writeOpenCodeConfig({ model: "anthropic/claude-sonnet-5" });
    setEnv("ANTHROPIC_API_KEY", "sk-ant-fresh");
    const ok = usable(resolveAgentImportAuth("opencode", undefined, undefined));
    expect(ok.model.providerID).toBe("anthropic");
    expect(ok.getAuth()).toEqual({ scheme: "api-key", value: "sk-ant-fresh" });
  });

  /**
   * Coverage for the auto-fallback chain's env tier across all agents with
   * `authTokenEnvVars`. Pi / Hermes / Gemini were added in #1533 so the
   * chain picks up their env credentials the same way claude-code / codex /
   * opencode already did. If a future PR removes `authTokenEnvVars` from any
   * of these agents, the chain silently skips the env tier for that agent
   * — this test catches the regression before merge.
   */
  describe("env-credential coverage across agents", () => {
    test("claude-code picks up ANTHROPIC_API_KEY (api-key scheme)", () => {
      setEnv("ANTHROPIC_API_KEY", "sk-ant-cc");
      const ok = usable(
        resolveAgentImportAuth("claude-code", undefined, undefined),
      );
      expect(ok.getAuth()).toEqual({ scheme: "api-key", value: "sk-ant-cc" });
    });

    test("claude-code: ANTHROPIC_AUTH_TOKEN (bearer) wins over ANTHROPIC_API_KEY when both set", () => {
      setEnv("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat-cc");
      setEnv("ANTHROPIC_API_KEY", "sk-ant-apikey-cc");
      const ok = usable(
        resolveAgentImportAuth("claude-code", undefined, undefined),
      );
      expect(ok.getAuth()).toEqual({
        scheme: "bearer",
        value: "sk-ant-oat-cc",
      });
    });

    test("codex picks up OPENAI_API_KEY (bearer scheme)", () => {
      setEnv("OPENAI_API_KEY", "sk-codex");
      const ok = usable(resolveAgentImportAuth("codex", undefined, undefined));
      expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "sk-codex" });
    });

    test("pi picks up ANTHROPIC_API_KEY (api-key scheme) — added in #1533", () => {
      setEnv("ANTHROPIC_API_KEY", "sk-ant-pi");
      const ok = usable(resolveAgentImportAuth("pi", undefined, undefined));
      expect(ok.getAuth()).toEqual({ scheme: "api-key", value: "sk-ant-pi" });
    });

    test("pi: ANTHROPIC_AUTH_TOKEN (bearer) wins over ANTHROPIC_API_KEY — parity with claude-code", () => {
      setEnv("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat-pi");
      setEnv("ANTHROPIC_API_KEY", "sk-ant-apikey-pi");
      const ok = usable(resolveAgentImportAuth("pi", undefined, undefined));
      expect(ok.getAuth()).toEqual({
        scheme: "bearer",
        value: "sk-ant-oat-pi",
      });
    });

    test("hermes picks up OPENAI_API_KEY (bearer scheme) — added in #1533", () => {
      setEnv("OPENAI_API_KEY", "sk-hermes");
      const ok = usable(resolveAgentImportAuth("hermes", undefined, undefined));
      expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "sk-hermes" });
    });

    test("gemini picks up GEMINI_API_KEY (bearer scheme) — added in #1533", () => {
      setEnv("GEMINI_API_KEY", "gem-key");
      const ok = usable(resolveAgentImportAuth("gemini", undefined, undefined));
      expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "gem-key" });
    });

    test("gemini: GOOGLE_API_KEY (bearer) is also honored — older sibling", () => {
      setEnv("GOOGLE_API_KEY", "goog-key");
      const ok = usable(resolveAgentImportAuth("gemini", undefined, undefined));
      expect(ok.getAuth()).toEqual({ scheme: "bearer", value: "goog-key" });
    });
  });
});
