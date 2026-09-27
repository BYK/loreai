import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRejectedUpstreamRequest } from "../src/upstream-400-capture";

describe("upstream 400 local capture", () => {
  const originalPath = process.env.LORE_UPSTREAM_400_CAPTURE_PATH;
  const originalSession = process.env.LORE_UPSTREAM_400_CAPTURE_SESSION;
  const directories: string[] = [];

  afterEach(() => {
    if (originalPath === undefined)
      delete process.env.LORE_UPSTREAM_400_CAPTURE_PATH;
    else process.env.LORE_UPSTREAM_400_CAPTURE_PATH = originalPath;
    if (originalSession === undefined)
      delete process.env.LORE_UPSTREAM_400_CAPTURE_SESSION;
    else process.env.LORE_UPSTREAM_400_CAPTURE_SESSION = originalSession;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function capturePath(): string {
    const directory = mkdtempSync(join(tmpdir(), "lore-400-capture-"));
    directories.push(directory);
    return join(directory, "request.json");
  }

  it("requires a path and exact session, then captures only the first rejected body privately", () => {
    const path = capturePath();
    process.env.LORE_UPSTREAM_400_CAPTURE_PATH = path;
    delete process.env.LORE_UPSTREAM_400_CAPTURE_SESSION;
    captureRejectedUpstreamRequest("session-a", '{"secret":"a"}', true);
    expect(existsSync(path)).toBe(false);

    process.env.LORE_UPSTREAM_400_CAPTURE_SESSION = "session-a";
    captureRejectedUpstreamRequest("session-b", '{"secret":"b"}', true);
    expect(existsSync(path)).toBe(false);

    captureRejectedUpstreamRequest("session-a", '{"secret":"a"}', false);
    expect(existsSync(path)).toBe(false);

    captureRejectedUpstreamRequest("session-a", '{"secret":"a"}', true);
    captureRejectedUpstreamRequest("session-a", '{"secret":"later"}', true);
    expect(readFileSync(path, "utf8")).toBe('{"secret":"a"}');
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o077).toBe(0);
    }
  });

  it("never overwrites an existing capture", () => {
    const path = capturePath();
    process.env.LORE_UPSTREAM_400_CAPTURE_PATH = path;
    process.env.LORE_UPSTREAM_400_CAPTURE_SESSION = "session-a";
    writeFileSync(path, "previous capture");

    captureRejectedUpstreamRequest("session-a", '{"secret":"new"}', true);
    expect(readFileSync(path, "utf8")).toBe("previous capture");
  });
});
