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
});
