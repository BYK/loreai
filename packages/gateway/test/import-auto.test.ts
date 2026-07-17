import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Auto-accept the Y/n prompt without touching real stdin: stub readline's
// createInterface so question() immediately answers "y" and close() is a no-op.
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb("y"),
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
import type { GatewayConfig } from "../src/config";

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

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    if (prevIsTTY) Object.defineProperty(process.stdin, "isTTY", prevIsTTY);
    rmSync(project, { recursive: true, force: true });
    _resetPendingImportForTest();
    _resetAuthForTest();
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

  test("deferred → flush with a MISMATCHED provider skips loudly (no silent no-op)", async () => {
    // Default model provider is anthropic (no cfg.model). Defer, then the first
    // authenticated turn is openai — the extraction can't use an openai key, so
    // the job must skip AND tell the user why (not vanish silently).
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);

    // Simulate the first turn authenticating openai.
    setLastSeenAuth({ scheme: "api-key", value: "sk-openai" }, "openai");
    logs.length = 0;
    await flushPendingImport("openai");

    expect(hasPendingImport()).toBe(false); // one-shot consumed
    const out = logs.join("\n");
    expect(out).toContain("Skipping knowledge import");
    expect(out).toContain("openai");
    expect(out).toContain("anthropic");
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
    // must still tell the user it was skipped — never a silent drop.
    await maybeAutoImport(baseConfig());
    expect(hasPendingImport()).toBe(true);

    // No credential set for anthropic → resolveAuth(undefined, "anthropic") null.
    logs.length = 0;
    await flushPendingImport(undefined);

    expect(hasPendingImport()).toBe(false);
    const out = logs.join("\n");
    expect(out).toContain("Skipping knowledge import");
    expect(out).toContain("no usable anthropic credential");
  });
});
