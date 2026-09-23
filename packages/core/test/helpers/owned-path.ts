import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

export interface RootIdentity {
  dev: bigint;
  ino: bigint;
}

export interface OwnedPath {
  path: string;
  identity: RootIdentity;
  markerName?: string;
  markerValue?: string;
  parent?: OwnedPath;
  cleanupPath?: string;
  cleaned: boolean;
}

export interface RemoveOwnedPathOptions {
  beforeRemove?: (path: string) => void | Promise<void>;
  remove?: (path: string) => void | Promise<void>;
}

export interface CreateOwnedRootOptions {
  prefix: string;
  parent?: string;
  mkdtemp?: (prefix: string) => Promise<string>;
  writeMarker?: (path: string, value: string) => Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function markerPath(root: string, owned: OwnedPath): string | undefined {
  return owned.markerName === undefined
    ? undefined
    : join(root, owned.markerName);
}

function isOwnedAtSync(root: string, owned: OwnedPath): boolean {
  try {
    if (owned.parent && !isOwnedAtSync(owned.parent.path, owned.parent)) {
      return false;
    }
    const current = lstatSync(root, { bigint: true });
    if (
      !current.isDirectory() ||
      current.dev !== owned.identity.dev ||
      current.ino !== owned.identity.ino
    ) {
      return false;
    }
    const marker = markerPath(root, owned);
    return (
      owned.markerValue === undefined ||
      (marker !== undefined &&
        readFileSync(marker, "utf8") === owned.markerValue)
    );
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isPresentAtSync(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function cleanupPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.lore-cleanup-${randomUUID()}`);
}

function removeOptions(_path: string): Parameters<typeof rmSync>[1] {
  return {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 100,
  };
}

/**
 * Detach an owned directory before removing it. The detached pathname is
 * private and verified again, so a replacement at the original pathname is
 * never recursively removed.
 */
export function removeOwnedPathSync(
  owned: OwnedPath,
  options: {
    beforeRemove?: (path: string) => void;
    remove?: (path: string) => void;
  } = {},
): void {
  if (owned.cleaned) return;

  if (owned.cleanupPath === undefined) {
    if (!isOwnedAtSync(owned.path, owned)) {
      owned.cleaned = true;
      return;
    }
    const detached = cleanupPath(owned.path);
    try {
      renameSync(owned.path, detached);
    } catch (error) {
      if (isMissing(error)) {
        owned.cleaned = true;
        return;
      }
      throw error;
    }
    owned.cleanupPath = detached;
  }

  const detached = owned.cleanupPath;
  if (detached === undefined) throw new Error("owned cleanup path is missing");
  if (!isOwnedAtSync(detached, owned)) {
    if (isPresentAtSync(detached)) {
      throw new Error("owned cleanup path changed during cleanup");
    }
    owned.cleanupPath = undefined;
    owned.cleaned = true;
    return;
  }

  options.beforeRemove?.(detached);
  if (!isOwnedAtSync(detached, owned)) {
    if (isPresentAtSync(detached)) {
      throw new Error("owned cleanup path changed during cleanup");
    }
    owned.cleanupPath = undefined;
    owned.cleaned = true;
    return;
  }
  (options.remove ?? ((path) => rmSync(path, removeOptions(path))))(detached);
  owned.cleanupPath = undefined;
  owned.cleaned = true;
}

export async function removeOwnedPath(
  owned: OwnedPath,
  options: RemoveOwnedPathOptions = {},
): Promise<void> {
  if (owned.cleaned) return;

  if (owned.cleanupPath === undefined) {
    if (!isOwnedAtSync(owned.path, owned)) {
      owned.cleaned = true;
      return;
    }
    const detached = cleanupPath(owned.path);
    try {
      renameSync(owned.path, detached);
    } catch (error) {
      if (isMissing(error)) {
        owned.cleaned = true;
        return;
      }
      throw error;
    }
    owned.cleanupPath = detached;
  }

  const detached = owned.cleanupPath;
  if (detached === undefined) throw new Error("owned cleanup path is missing");
  if (!isOwnedAtSync(detached, owned)) {
    if (isPresentAtSync(detached)) {
      throw new Error("owned cleanup path changed during cleanup");
    }
    owned.cleanupPath = undefined;
    owned.cleaned = true;
    return;
  }

  await options.beforeRemove?.(detached);
  if (!isOwnedAtSync(detached, owned)) {
    if (isPresentAtSync(detached)) {
      throw new Error("owned cleanup path changed during cleanup");
    }
    owned.cleanupPath = undefined;
    owned.cleaned = true;
    return;
  }
  if (options.remove) await options.remove(detached);
  else rmSync(detached, removeOptions(detached));
  owned.cleanupPath = undefined;
  owned.cleaned = true;
}

export async function createOwnedRoot(
  options: CreateOwnedRootOptions,
): Promise<OwnedPath> {
  const makeTemp = options.mkdtemp ?? ((prefix: string) => mkdtemp(prefix));
  const writeMarker =
    options.writeMarker ??
    ((path: string, value: string) =>
      writeFile(path, value, { encoding: "utf8", flag: "wx" }));
  let owned: OwnedPath | undefined;

  try {
    const root = await makeTemp(
      join(options.parent ?? tmpdir(), options.prefix),
    );
    const created = await lstat(root, { bigint: true });
    owned = {
      path: root,
      identity: { dev: created.dev, ino: created.ino },
      markerName: ".lore-owned-root",
      markerValue: undefined,
      cleaned: false,
    };
    const markerValue = randomUUID();
    await writeMarker(join(root, ".lore-owned-root"), markerValue);
    owned.markerValue = markerValue;
    return owned;
  } catch (error) {
    if (!owned) throw error;
    try {
      await removeOwnedPath(owned);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "owned root initialization and cleanup failed",
      );
    }
    throw error;
  }
}
