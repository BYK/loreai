import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createTestDatabasePath } from "../../core/test/helpers/test-db-path";
import {
  loopbackRequest,
  type LoopbackRequestInit,
} from "./helpers/loopback-request";

let baseURL: string;
let dbPath: string;
let server: { stop: () => Promise<void>; port: number; hosts: string[] };
let core: typeof import("@loreai/core");
let normalizeRepoPath: typeof import("../src/knowledge-files").normalizeRepoPath;

beforeAll(async () => {
  dbPath = createTestDatabasePath("knowledge-files-api");
  process.env.LORE_DB_PATH = dbPath;
  process.env.LORE_LISTEN_PORT = "0";
  process.env.LORE_DEBUG = "false";

  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  core = await import("@loreai/core");
  ({ normalizeRepoPath } = await import("../src/knowledge-files"));
  core.close();

  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  server = await startServer(config);
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.stop();
  if (core) core.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${dbPath}${suffix}`;
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* best-effort */
    }
  }
});

function api(path: string, init?: LoopbackRequestInit): Promise<Response> {
  return loopbackRequest(`${baseURL}${path}`, init);
}

async function responseFor(id: string): Promise<Response> {
  return api(`/api/v1/knowledge/${encodeURIComponent(id)}/files`);
}

function seedEntry(options: {
  title: string;
  projectPath?: string;
  paths?: string[];
  anchors?: Array<{ kind: "file" | "symbol"; anchor: string }>;
  gitHead?: string;
  gitRemote?: string | null;
}): { id: string; logicalId: string; projectPath: string } {
  const projectPath =
    options.projectPath ?? `/test/knowledge-files/${randomUUID()}`;
  const projectId = core.ensureProject(projectPath, "knowledge-files");
  core
    .db()
    .query("UPDATE projects SET git_remote = ? WHERE id = ?")
    .run(
      options.gitRemote === undefined
        ? "github.com/example/repo"
        : options.gitRemote,
      projectId,
    );
  const id = core.ltm.create({
    projectPath,
    scope: "project",
    category: "decision",
    title: options.title,
    content: "Knowledge file link test entry.",
    ...(options.gitHead === undefined
      ? {}
      : { metadata: { gitHead: options.gitHead } }),
  });
  const logicalId = core.ltm.logicalIdOf(id);
  if (options.paths) core.ltm.setFileRefs(logicalId, options.paths);
  for (const anchor of options.anchors ?? []) {
    core
      .db()
      .query(
        `INSERT INTO knowledge_ref_anchor (logical_id, kind, anchor, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(logicalId, anchor.kind, anchor.anchor, Date.now());
  }
  return { id, logicalId, projectPath };
}

describe("normalizeRepoPath", () => {
  it("normalizes relative paths and absolute paths under the project root", () => {
    expect(normalizeRepoPath(" ./src//file.ts ", "/repo")).toBe("src/file.ts");
    expect(normalizeRepoPath("/repo/src/file.ts", "/repo")).toBe("src/file.ts");
  });

  it.each([
    ["", "/repo"],
    ["/outside/file.ts", "/repo"],
    ["../x", "/repo"],
    ["a/./b", "/repo"],
    ["bad\u0001path", "/repo"],
    ["bad\\path", "/repo"],
    ["src/file.ts/", "/repo"],
    ["/repo", "/repo"],
  ])("rejects unsafe path %j", (path, root) => {
    expect(normalizeRepoPath(path, root)).toBeNull();
  });
});

describe("GET /api/v1/knowledge/:id/files", () => {
  it("returns 404 for an unknown ID", async () => {
    const response = await responseFor(randomUUID());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        type: "not_found",
        message: expect.stringMatching(/^Knowledge entry not found: /),
      },
    });
  });

  it("returns the exact empty response shape", async () => {
    const seeded = seedEntry({ title: `Empty ${randomUUID()}` });
    const response = await responseFor(seeded.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: seeded.logicalId,
      git_remote: "github.com/example/repo",
      commit: null,
      files: [],
      omitted: 0,
    });
  });

  it("sorts relative paths and relativizes absolute paths under the project", async () => {
    const projectPath = `/repo/${randomUUID()}`;
    const seeded = seedEntry({
      title: `Sorted paths ${randomUUID()}`,
      projectPath,
      paths: ["z.ts", `${projectPath}/src/a.ts`, "a.ts"],
    });

    const response = await responseFor(seeded.id);
    const body = (await response.json()) as {
      files: Array<{ path: string; recorded: boolean; verified: boolean }>;
    };
    expect(body.files).toEqual([
      { path: "a.ts", recorded: true, verified: false },
      { path: "src/a.ts", recorded: true, verified: false },
      { path: "z.ts", recorded: true, verified: false },
    ]);
  });

  it("counts rejected recorded and anchor paths and returns more than three refs", async () => {
    const seeded = seedEntry({
      title: `Invalid and many paths ${randomUUID()}`,
      paths: [
        "/outside/file.ts",
        "../x",
        "a/./b",
        "bad\u0001path",
        "bad\\path",
        "z.ts",
        "a.ts",
        "b.ts",
        "c.ts",
        "d.ts",
      ],
      anchors: [{ kind: "file", anchor: "/outside/verified.ts:4" }],
    });
    const response = await responseFor(seeded.id);
    const body = (await response.json()) as {
      files: Array<{ path: string }>;
      omitted: number;
    };
    expect(response.status).toBe(200);
    expect(body.files.map((file) => file.path)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "z.ts",
    ]);
    expect(body.omitted).toBe(6);
  });

  it("omits basename-only file anchors and merges repository-relative file anchors", async () => {
    const seeded = seedEntry({
      title: `Anchor merge ${randomUUID()}`,
      paths: ["src/used.ts"],
      anchors: [
        { kind: "file", anchor: "ltm.ts:42" },
        { kind: "file", anchor: "src/a.ts:42" },
        { kind: "file", anchor: "src/used.ts:42" },
        { kind: "file", anchor: "src/range.ts:2-4" },
        { kind: "file", anchor: "src/column.ts:2:4" },
        { kind: "symbol", anchor: "buildThing" },
      ],
    });
    const response = await responseFor(seeded.id);
    const body = (await response.json()) as {
      files: Array<{ path: string; recorded: boolean; verified: boolean }>;
      omitted: number;
    };
    expect(body.files).toEqual([
      { path: "src/a.ts", recorded: false, verified: true },
      { path: "src/column.ts", recorded: false, verified: true },
      { path: "src/range.ts", recorded: false, verified: true },
      { path: "src/used.ts", recorded: true, verified: true },
    ]);
    expect(body.omitted).toBe(1);
  });

  it("returns only a well-formed recorded gitHead and the project remote", async () => {
    const valid = seedEntry({
      title: `Valid git head ${randomUUID()}`,
      gitHead: "0123456789abcdef0123456789abcdef01234567",
    });
    const validResponse = await responseFor(valid.id);
    expect(await validResponse.json()).toMatchObject({
      git_remote: "github.com/example/repo",
      commit: "0123456789abcdef0123456789abcdef01234567",
    });

    const malformed = seedEntry({
      title: `Invalid git head ${randomUUID()}`,
      gitHead: "0123456-not-a-commit",
      gitRemote: null,
    });
    const malformedResponse = await responseFor(malformed.id);
    expect(await malformedResponse.json()).toMatchObject({
      git_remote: null,
      commit: null,
    });
  });

  it("normalizes the stored project remote", async () => {
    const seeded = seedEntry({
      title: `Normalized project remote ${randomUUID()}`,
      gitRemote: "git@github.com:Owner/Repo.git",
    });
    const response = await responseFor(seeded.id);
    expect(await response.json()).toMatchObject({
      git_remote: "github.com/Owner/Repo",
    });
  });

  it("resolves superseded IDs to the current logical entry and hides deleted entries", async () => {
    const seeded = seedEntry({
      title: `Versioned entry ${randomUUID()}`,
      paths: ["src/current.ts"],
    });
    core.ltm.appendVersion(seeded.id, { content: "Current version content." });
    const superseded = await responseFor(seeded.id);
    expect(await superseded.json()).toMatchObject({
      id: seeded.logicalId,
      files: [{ path: "src/current.ts", recorded: true, verified: false }],
    });

    core.ltm.remove(seeded.id);
    const deleted = await responseFor(seeded.id);
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toMatchObject({
      error: {
        type: "not_found",
        message: `Knowledge entry not found: ${seeded.id}`,
      },
    });
  });
});
