import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createOwnedRoot, removeOwnedPath, type OwnedPath } from "./owned-path";

const testRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...testRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  testRoots.clear();
});

async function makeOwnedPath(): Promise<OwnedPath> {
  const root = await mkdtemp(join(tmpdir(), "lore-owned-path-test-"));
  testRoots.add(root);
  const markerName = ".lore-owned-root";
  const markerValue = "test-marker";
  await writeFile(join(root, markerName), markerValue, { flag: "wx" });
  const identity = await lstat(root, { bigint: true });
  return {
    path: root,
    identity: { dev: identity.dev, ino: identity.ino },
    markerName,
    markerValue,
    cleaned: false,
  };
}

describe("owned-path cleanup", () => {
  test("does not mark cleanup complete when removal fails and retries", async () => {
    const owned = await makeOwnedPath();
    let attempts = 0;

    await expect(
      removeOwnedPath(owned, {
        remove: async (path) => {
          attempts++;
          if (attempts === 1) throw new Error("transient removal failure");
          await rm(path, { recursive: true, force: true });
        },
      }),
    ).rejects.toThrow("transient removal failure");
    expect(owned.cleaned).toBe(false);

    await removeOwnedPath(owned, {
      remove: async (path) => {
        await rm(path, { recursive: true, force: true });
      },
    });
    await expect(lstat(owned.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves a replacement created while cleanup is detaching the root", async () => {
    const owned = await makeOwnedPath();
    const replacementFile = join(owned.path, "replacement");

    await removeOwnedPath(owned, {
      beforeRemove: async () => {
        await mkdir(owned.path);
        await writeFile(replacementFile, "preserve");
      },
    });

    await expect(readFile(replacementFile, "utf8")).resolves.toBe("preserve");
  });

  test("removes a root when marker publication fails after allocation", async () => {
    let allocatedRoot = "";
    await expect(
      createOwnedRoot({
        prefix: "lore-owned-path-init-test-",
        mkdtemp: async (prefix) => {
          const root = await mkdtemp(prefix);
          allocatedRoot = root;
          return root;
        },
        writeMarker: async () => {
          throw new Error("marker publication failed");
        },
      }),
    ).rejects.toThrow("marker publication failed");

    await expect(lstat(allocatedRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
