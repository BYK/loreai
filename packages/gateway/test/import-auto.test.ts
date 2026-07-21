import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Auto-answer the Y/n prompt without touching real stdin. `promptAnswer` lets
// individual tests choose accept ("y") vs decline ("n").
let promptAnswer = "y";
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(promptAnswer),
    close: () => {},
  }),
}));

import { maybeAutoImport } from "../src/cli/import-auto";
import {
  hasPendingImport,
  flushPendingImport,
  _resetPendingImportForTest,
} from "../src/pending-import";
import { setLastSeenAuth, _resetAuthForTest } from "../src/auth";
import { conversationImport, load as loadConfig } from "@loreai/core";
import { writeFileSync } from "node:fs";
import type { GatewayConfig } from "../src/config";

const { hasAgentImportRecord } = conversationImport;

const AIDER_FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "core",
  "test",
  "import",
  "fixtures",
  "aider-history.md",
);

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  // Only the fields maybeAutoImport reads matter; cast the rest.
  return {
    upstreamAnthropic: "https://api.anthropic.com",
    upstreamOpenAI: "https://api.openai.com",
    ...overrides,
  } as GatewayConfig;
}

describe("maybeAutoImport — credential-aware scheduling", () => {
  let project: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const logs: string[] = [];
  let prevIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    _resetPendingImportForTest();
    _resetAuthForTest();
    promptAnswer = "y";
    project = mkdtempSync(join(tmpdir(), "lore-autoimport-"));
    // The tmp dir is intentionally NOT a git repo: detectAll(..., {worktrees:true})
    // runs `git worktree list`, which fails open to [projectPath] here — so
    // detection is scoped to exactly this dir and the copied-in fixture. Keeps
    // the test deterministic and free of home-dir/repo leakage.
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
    logs.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    // Force TTY so promptYesNo reaches the (mocked) readline that answers "y".
    prevIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    if (prevIsTTY) Object.defineProperty(process.stdin, "isTTY", prevIsTTY);
    rmSync(project, { recursive: true, force: true });
    _resetPendingImportForTest();
    _resetAuthForTest();
    // Reset the config singleton in case a test loaded a .lore.json with a model.
    await loadConfig(tmpdir());
  });

  test("no credential, no worker key → import is DEFERRED to the first turn", async () => {
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);
    expect(logs.join("\n")).toContain("after your first message");
    expect(logs.join("\n")).not.toContain("Importing knowledge in background");
  });

  test("worker key set → import runs immediately (not deferred)", async () => {
    await maybeAutoImport(baseConfig({ workerApiKey: "sk-worker-test" }));
    expect(hasPendingImport()).toBe(false);
    expect(logs.join("\n")).toContain("Importing knowledge in background");
    expect(logs.join("\n")).not.toContain("after your first message");
  });

  test("session credential present → import runs immediately (not deferred)", async () => {
    setLastSeenAuth({ scheme: "bearer", value: "sk-ant-oat-xxx" }, "anthropic");
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(false);
    expect(logs.join("\n")).toContain("Importing knowledge in background");
  });

  test("deferred → flush with an unresolved credential skips loudly (no silent no-op)", async () => {
    // No cfg.model, so the default provider (anthropic) is only a fallback —
    // not a user choice. Even when the first authenticated turn is a different
    // provider (openai) with no anthropic credential resolvable, we must NOT
    // tell the user to authenticate "anthropic" (they never chose it). Instead
    // give the neutral, still-actionable "send one message" notice — and never
    // vanish silently.
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);

    // Simulate the first turn authenticating openai.
    setLastSeenAuth({ scheme: "api-key", value: "sk-openai" }, "openai");
    logs.length = 0;
    await flushPendingImport("openai");

    // Re-registered (NOT consumed): a one-shot drop here would permanently
    // lose the import and make the "send one message" promise a lie (Seer
    // #15392788). A later usable-credential turn must be able to retry.
    expect(hasPendingImport()).toBe(true);
    const out = logs.join("\n");
    expect(out).toContain("Skipping knowledge import");
    // Neutral copy: no provider name baked in when the model wasn't configured.
    expect(out).not.toContain("anthropic");
    expect(out).toContain("Send one message");
  });

  test("explicit cfg.model + mismatched provider → names both providers", async () => {
    // When the user EXPLICITLY configured a model, naming the provider in the
    // mismatch message is helpful (it reflects a real choice they made).
    writeFileSync(
      join(project, ".lore.json"),
      JSON.stringify({
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      }),
    );
    await loadConfig(project);

    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);

    setLastSeenAuth({ scheme: "api-key", value: "sk-openai" }, "openai");
    logs.length = 0;
    await flushPendingImport("openai");

    const out = logs.join("\n");
    expect(out).toContain("Skipping knowledge import");
    expect(out).toContain("openai");
    expect(out).toContain("anthropic");
    // Re-registered so a later anthropic turn can still complete the import.
    expect(hasPendingImport()).toBe(true);
  });

  test("deferred → flush with a MATCHING provider proceeds to import", async () => {
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);

    // First turn authenticates anthropic — matches the default model provider.
    setLastSeenAuth({ scheme: "bearer", value: "sk-ant-oat" }, "anthropic");
    logs.length = 0;
    await flushPendingImport("anthropic");

    expect(hasPendingImport()).toBe(false);
    // The matching-provider path does NOT hit the mismatch skip branch.
    expect(logs.join("\n")).not.toContain("Skipping knowledge import");
  });

  test("deferred → flush with UNKNOWN provider and no usable credential skips loudly (generic notice)", async () => {
    // The credential can't be resolved for the default (anthropic) model and the
    // trigger carried no provider info (authedProviderID undefined). The import
    // must still tell the user it was skipped — never a silent drop. With no
    // cfg.model, the notice is provider-neutral.
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);

    // No credential set for anthropic → resolveAuth(undefined, "anthropic") null.
    logs.length = 0;
    await flushPendingImport(undefined);

    expect(hasPendingImport()).toBe(true); // re-registered, not consumed
    const out = logs.join("\n");
    expect(out).toContain("Skipping knowledge import");
    expect(out).toContain("no usable credential is available yet");
    expect(out).not.toContain("anthropic");
  });

  test("skipped deferred import is RETRIED on a later usable-credential turn (not lost)", async () => {
    // Seer #15392788: the one-shot flush must not permanently drop the import
    // when the first authenticated turn's credential isn't usable. A later turn
    // that binds a usable credential must still complete it.
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);

    // Turn 1: authenticates a provider with no resolvable credential for the
    // default (anthropic) model → skip + re-register.
    setLastSeenAuth({ scheme: "api-key", value: "sk-openai" }, "openai");
    logs.length = 0;
    await flushPendingImport("openai");
    expect(logs.join("\n")).toContain("Skipping knowledge import");
    expect(hasPendingImport()).toBe(true);

    // Turn 2: a usable anthropic credential lands → the retry proceeds to
    // import (does NOT hit the skip branch) and consumes the pending job.
    setLastSeenAuth({ scheme: "bearer", value: "sk-ant-oat" }, "anthropic");
    logs.length = 0;
    await flushPendingImport("anthropic");
    expect(logs.join("\n")).not.toContain("Skipping knowledge import");
    expect(hasPendingImport()).toBe(false); // consumed by the successful run
  });

  test("ACCEPT with deferred import does NOT pre-record the agent (no permanent suppression)", async () => {
    // No credential → import defers. The agent must NOT be marked handled yet,
    // or a never-fired import would suppress the offer forever (the user trap).
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);
    expect(hasAgentImportRecord(project, "aider")).toBe(false);
  });

  test("DECLINE records the agent so it is not re-offered", async () => {
    promptAnswer = "n";
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(false);
    expect(hasAgentImportRecord(project, "aider")).toBe(true);
  });
});
