import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Mock the gateway-relative remote layer so commandImport runs in "remote mode"
// (no gateway startup, no real LLM). These mocks work because they target
// gateway-relative paths, not the aliased @loreai/core barrel.
const remotePostMock = vi.fn(async () => ({
  created: 2,
  updated: 1,
  deleted: 0,
  failed: 0,
  chunks: 3,
}));
const remoteGetMock = vi.fn(async () => [] as unknown);

vi.mock("../src/cli/remote", () => ({
  getRemoteUrl: () => process.env.LORE_REMOTE_URL,
  projectQueryParams: () => "path=/x",
  remoteGet: (...a: unknown[]) => remoteGetMock(...(a as [])),
  remotePost: (...a: unknown[]) => remotePostMock(...(a as [])),
}));

// commandImport in remote mode never starts a gateway, but guard the import.
vi.mock("../src/cli/start", () => ({
  startGateway: vi.fn(async () => {
    throw new Error("startGateway must not be called in remote mode");
  }),
}));

import { commandImport } from "../src/cli/import";

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

describe("commandImport (remote mode)", () => {
  let project: string;
  const logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const prevRemote = process.env.LORE_REMOTE_URL;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "lore-cmdimport-"));
    process.env.LORE_REMOTE_URL = "https://gw.example";
    logs.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    remotePostMock.mockClear();
    remoteGetMock.mockClear();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(project, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.LORE_REMOTE_URL;
    else process.env.LORE_REMOTE_URL = prevRemote;
  });

  test("no prior history → early return, no remote call", async () => {
    await commandImport([], { project, yes: true });
    expect(logs.join("\n")).toContain("No prior AI conversation history");
    expect(remotePostMock).not.toHaveBeenCalled();
  });

  test("--agent with no match → early return", async () => {
    // An aider history exists, but the user filtered to a different agent.
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    await commandImport([], { project, agent: "codex", yes: true });
    expect(logs.join("\n")).toContain(
      'No conversation history found from "codex"',
    );
    expect(remotePostMock).not.toHaveBeenCalled();
  });

  test("detected history → dedup filter runs → delegates to remote", async () => {
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    await commandImport([], { project, agent: "aider", yes: true });
    // filterAlreadyImported kept the fresh session and we routed to the remote.
    expect(remoteGetMock).toHaveBeenCalled(); // fetched remote import history
    expect(remotePostMock).toHaveBeenCalled(); // delegated extraction
    expect(logs.join("\n")).toContain("Using remote gateway");
  });

  test("dry-run → summarizes but never calls the remote", async () => {
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    await commandImport([], { project, agent: "aider", "dry-run": true });
    expect(logs.join("\n")).toContain("Dry run");
    expect(remotePostMock).not.toHaveBeenCalled();
  });
});
