/**
 * Tests for `lore data show knowledge <id>` metadata rendering (#627 Phase 1).
 *
 * The display path JSON-stringifies the parsed `metadata` object — without the
 * stringify, an object would render as `[object Object]`. These tests drive the
 * real `commandData` dispatcher against a temp project so the actual CLI handler
 * (`cmdShow`) executes, covering the metadata branch.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ltm } from "@loreai/core";
import { commandData } from "../src/cli/data";

let projectDir: string;
let logLines: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lore-show-meta-"));
  logLines = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("lore data show knowledge — metadata rendering (#627 Phase 1)", () => {
  test("renders metadata as JSON, not [object Object]", async () => {
    const id = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Show with metadata",
      content: "body",
      scope: "project",
      metadata: { gitHead: "abc1234deadbeef" },
    });

    await commandData(["show", "knowledge", id], { project: projectDir });

    const metaLine = logLines.find((l) => l.startsWith("Metadata:"));
    expect(metaLine).toBeDefined();
    // The bug guarded: an object would stringify to "[object Object]".
    expect(metaLine).not.toContain("[object Object]");
    expect(metaLine).toContain('{"gitHead":"abc1234deadbeef"}');
  });

  test("omits the Metadata line entirely when there is no metadata", async () => {
    const id = ltm.create({
      projectPath: projectDir,
      category: "decision",
      title: "Show without metadata",
      content: "body",
      scope: "project",
    });

    await commandData(["show", "knowledge", id], { project: projectDir });

    expect(logLines.some((l) => l.startsWith("Metadata:"))).toBe(false);
    // Sanity: the entry itself still rendered.
    expect(logLines.some((l) => l.includes("Show without metadata"))).toBe(
      true,
    );
  });
});

// The remote path (LORE_REMOTE_URL set) routes through cmdShowRemote, which
// fetches the entry from the gateway API. The API serializes ltm.get()'s
// hydrated entry, so metadata arrives as a parsed object and is JSON-stringified
// for display — same contract as the local path.
describe("lore data show knowledge — remote metadata rendering (#627 Phase 1)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.LORE_REMOTE_URL;
  });

  function mockRemoteEntry(metadata: unknown): void {
    process.env.LORE_REMOTE_URL = "https://remote.example";
    const entry = {
      id: "remote-entry-1",
      category: "decision",
      title: "Remote entry",
      content: "remote body",
      confidence: 1,
      project_id: null,
      cross_project: true,
      source_session: null,
      created_at: 0,
      updated_at: 0,
      metadata,
    };
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(entry), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  test("renders remote metadata object as JSON, not [object Object]", async () => {
    mockRemoteEntry({ gitHead: "remotedeadbeef" });

    await commandData(["show", "knowledge", "remote-entry-1"], {});

    const metaLine = logLines.find((l) => l.startsWith("Metadata:"));
    expect(metaLine).toBeDefined();
    expect(metaLine).not.toContain("[object Object]");
    expect(metaLine).toContain('{"gitHead":"remotedeadbeef"}');
  });

  test("omits the remote Metadata line when metadata is null", async () => {
    mockRemoteEntry(null);

    await commandData(["show", "knowledge", "remote-entry-1"], {});

    expect(logLines.some((l) => l.startsWith("Metadata:"))).toBe(false);
    expect(logLines.some((l) => l.includes("Remote entry"))).toBe(true);
  });
});
