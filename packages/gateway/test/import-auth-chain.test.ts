import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentImportAuth } from "../src/cli/import";
import { workerKeyScheme } from "../src/auth";

let tmp: string;
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
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  for (const k of Object.keys(saved)) delete saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveAgentImportAuth", () => {
  test("worker key wins over harness auth; provider from cfg.model", () => {
    writeOpenCodeAuth({ openrouter: { type: "api", key: "disk-key" } });
    const res = resolveAgentImportAuth("opencode", "worker-key-123", {
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    });
    expect(res).not.toBeNull();
    expect(res?.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    });
    const cred = res?.getAuth(undefined, "openai");
    expect(cred).toEqual({
      scheme: workerKeyScheme("openai"),
      value: "worker-key-123",
    });
  });

  test("worker key with no cfg.model defaults provider to anthropic", () => {
    const res = resolveAgentImportAuth("opencode", "wk", undefined);
    expect(res?.model.providerID).toBe("anthropic");
    expect(res?.getAuth(undefined, undefined)).toEqual({
      scheme: "api-key",
      value: "wk",
    });
  });

  test("harness on-disk api-key is used when no worker key", () => {
    writeOpenCodeAuth({ openrouter: { type: "api", key: "sk-or-xyz" } });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    expect(res).not.toBeNull();
    expect(res?.model.providerID).toBe("openrouter");
    expect(res?.getAuth()).toEqual({ scheme: "api-key", value: "sk-or-xyz" });
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
    expect(res).not.toBeNull();
    expect(res?.model.providerID).toBe("github-copilot");
    expect(res?.getAuth()).toEqual({
      scheme: "bearer",
      value: "gho_refresh",
    });
  });

  test("prefers a routable credential over an unroutable earlier one", () => {
    writeOpenCodeAuth({
      "nonexistent-provider": { type: "api", key: "skip-me" },
      minimax: { type: "api", key: "use-me" },
    });
    const res = resolveAgentImportAuth("opencode", undefined, undefined);
    expect(res?.model.providerID).toBe("minimax");
    expect(res?.getAuth()).toEqual({ scheme: "api-key", value: "use-me" });
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
    expect(res?.model.providerID).toBe("anthropic");
    // default model for anthropic
    expect(res?.model.modelID).toBe("claude-sonnet-5");
  });
});
