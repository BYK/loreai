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
  projectIdentity: (p: string) => ({ path: p }),
  projectQueryParams: (p: string) => `path=${encodeURIComponent(p)}`,
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
    remoteGetMock.mockReset().mockResolvedValue([]);
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

  test("project unknown to remote → proceeds without dedup + notes it", async () => {
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    remoteGetMock.mockResolvedValue([]); // /api/v1/projects is empty
    await commandImport([], { project, agent: "aider", yes: true });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("not yet known to remote gateway"),
    );
    // only the projects lookup — no imports page was requested
    expect(remoteGetMock).toHaveBeenCalledTimes(1);
    expect(remotePostMock).toHaveBeenCalled();
  });

  test("remote import history is paged via next_cursor", async () => {
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    remoteGetMock.mockImplementation(async (...args: unknown[]) => {
      const path = args[1] as string;
      if (path === "/api/v1/projects") {
        return [{ id: "p1", path: project, git_remote: null }];
      }
      if (path === "/api/v1/projects/p1/imports?limit=200") {
        return {
          imports: [
            {
              agent_name: "aider",
              source_id: "s1",
              source_hash: "h1",
            },
          ],
          next_cursor: "cursor-2",
        };
      }
      if (path === "/api/v1/projects/p1/imports?limit=200&page=cursor-2") {
        return {
          imports: [
            {
              agent_name: "aider",
              source_id: "s2",
              source_hash: "h2",
            },
          ],
          next_cursor: null,
        };
      }
      throw new Error(`unexpected remoteGet path: ${path}`);
    });
    await commandImport([], { project, agent: "aider", yes: true });
    const paths = remoteGetMock.mock.calls.map(
      (c) => (c as unknown as [string, string])[1],
    );
    expect(paths).toEqual([
      "/api/v1/projects",
      "/api/v1/projects/p1/imports?limit=200",
      "/api/v1/projects/p1/imports?limit=200&page=cursor-2",
    ]);
    expect(remotePostMock).toHaveBeenCalled();
  });

  test("dry-run → summarizes but never calls the remote", async () => {
    copyFileSync(AIDER_FIXTURE, join(project, ".aider.chat.history.md"));
    await commandImport([], { project, agent: "aider", "dry-run": true });
    expect(logs.join("\n")).toContain("Dry run");
    expect(remotePostMock).not.toHaveBeenCalled();
  });
});
