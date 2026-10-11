import { db } from "@loreai/core";
import { basename, dirname, resolve, sep } from "node:path";

type FileOptions = BufferEncoding | { encoding?: BufferEncoding | null };
type DirOptions = boolean | { recursive?: boolean; mode?: number };
type ReadlinkOptions =
  | BufferEncoding
  | "buffer"
  | { encoding?: BufferEncoding | "buffer" | null };

interface StoredPath {
  path: string;
  kind: "file" | "directory" | "symlink";
  contents: Uint8Array | null;
  link_target: string | null;
  mode: number;
  mtime_ms: number;
}

function canonical(path: string | URL): string {
  return resolve(typeof path === "string" ? path : path.pathname);
}

function pathPrefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function lookup(path: string): StoredPath | undefined {
  const row = db()
    .query(
      "SELECT path, kind, contents, link_target, mode, mtime_ms FROM fluid_spike_files WHERE path = ?",
    )
    .get(canonical(path));
  return row === null ? undefined : (row as unknown as StoredPath);
}

function resolveEntry(
  path: string | URL,
  followSymlinks = true,
): StoredPath | undefined {
  let target = canonical(path);
  const visited = new Set<string>();
  while (true) {
    const entry = lookup(target);
    if (!entry || entry.kind !== "symlink" || !followSymlinks) return entry;
    if (visited.has(target) || visited.size >= 40) {
      throw Object.assign(new Error(`ELOOP: ${target}`), { code: "ELOOP" });
    }
    visited.add(target);
    target = resolve(dirname(target), entry.link_target ?? "");
  }
}

function setDirectory(path: string, mode = 0o40755): void {
  const target = canonical(path);
  const existing = lookup(target);
  if (existing) {
    if (existing.kind !== "directory") {
      throw Object.assign(new Error(`EEXIST: ${target}`), { code: "EEXIST" });
    }
    return;
  }
  db()
    .query(
      `INSERT INTO fluid_spike_files(
         path, parent_path, basename, kind, contents, link_target, mode, mtime_ms
       ) VALUES (?, ?, ?, 'directory', NULL, NULL, ?, ?)`,
    )
    .run(target, dirname(target), basename(target), mode, Date.now());
}

async function mkdir(path: string | URL, options?: DirOptions): Promise<void> {
  const target = canonical(path);
  const recursive = typeof options === "object" && options.recursive === true;
  const existing = lookup(target);
  if (existing) {
    if (existing.kind !== "directory") {
      throw Object.assign(new Error(`EEXIST: ${target}`), { code: "EEXIST" });
    }
    if (recursive) return;
    throw Object.assign(new Error(`EEXIST: ${target}`), { code: "EEXIST" });
  }
  if (!recursive) {
    const parent = lookup(dirname(target));
    if (!parent || parent.kind !== "directory") {
      throw Object.assign(new Error(`ENOENT: ${dirname(target)}`), {
        code: "ENOENT",
      });
    }
    setDirectory(
      target,
      typeof options === "object" ? options.mode : undefined,
    );
    return;
  }
  const parts = target.split(sep);
  const firstPart = parts.shift();
  let current = firstPart === "" ? sep : (firstPart ?? sep);
  for (const part of parts.filter(Boolean)) {
    current = current === sep ? `${current}${part}` : `${current}${sep}${part}`;
    setDirectory(current);
  }
}

async function writeFile(
  path: string | URL,
  data: string | Uint8Array,
  options?: FileOptions,
): Promise<void> {
  let target = canonical(path);
  const existing = lookup(target);
  if (existing?.kind === "directory") {
    throw Object.assign(new Error(`EISDIR: ${target}`), { code: "EISDIR" });
  }
  if (existing?.kind === "symlink") {
    target = resolve(dirname(target), existing.link_target ?? "");
  }
  if (lookup(target)?.kind === "directory") {
    throw Object.assign(new Error(`EISDIR: ${target}`), { code: "EISDIR" });
  }
  await mkdir(dirname(target), { recursive: true });
  const encoding = typeof options === "string" ? options : options?.encoding;
  const contents =
    typeof data === "string"
      ? Buffer.from(data, encoding ?? "utf8")
      : Buffer.from(data);
  db()
    .query(
      `INSERT INTO fluid_spike_files(
         path, parent_path, basename, kind, contents, link_target, mode, mtime_ms
       ) VALUES (?, ?, ?, 'file', ?, NULL, 33188, ?)
       ON CONFLICT(path) DO UPDATE SET
         parent_path = excluded.parent_path,
         basename = excluded.basename,
         kind = 'file', contents = excluded.contents, link_target = NULL,
         mtime_ms = excluded.mtime_ms`,
    )
    .run(target, dirname(target), basename(target), contents, Date.now());
}

async function readFile(
  path: string | URL,
  options?: FileOptions,
): Promise<Buffer | string> {
  const entry = resolveEntry(path);
  if (!entry) {
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: "ENOENT",
    });
  }
  if (entry.kind !== "file") {
    const code = entry.kind === "directory" ? "EISDIR" : "EINVAL";
    throw Object.assign(new Error(`${code}: ${String(path)}`), { code });
  }
  if (!entry.contents) {
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: "ENOENT",
    });
  }
  const encoding = typeof options === "string" ? options : options?.encoding;
  const content = Buffer.from(entry.contents);
  return encoding ? content.toString(encoding) : content;
}

async function unlink(path: string | URL): Promise<void> {
  const target = canonical(path);
  const existing = lookup(target);
  if (!existing) {
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: "ENOENT",
    });
  }
  if (existing.kind === "directory") {
    throw Object.assign(new Error(`EISDIR: ${String(path)}`), {
      code: "EISDIR",
    });
  }
  const result = db()
    .query(
      "DELETE FROM fluid_spike_files WHERE path = ? AND kind != 'directory'",
    )
    .run(target);
  if (Number(result.changes) === 0) {
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: "ENOENT",
    });
  }
}

async function rmdir(
  path: string | URL,
  options?: { recursive?: boolean },
): Promise<void> {
  const target = canonical(path);
  const entry = lookup(target);
  if (!entry) {
    throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
  }
  if (entry.kind !== "directory") {
    throw Object.assign(new Error(`ENOTDIR: ${target}`), { code: "ENOTDIR" });
  }
  const prefix = target === sep ? sep : `${target}${sep}`;
  const upperBound = pathPrefixUpperBound(prefix);
  const children = db()
    .query("SELECT path FROM fluid_spike_files WHERE path > ? AND path < ?")
    .all(prefix, upperBound) as Array<{ path: string }>;
  if (children.length && !options?.recursive) {
    throw Object.assign(new Error(`ENOTEMPTY: ${target}`), {
      code: "ENOTEMPTY",
    });
  }
  db().query("DELETE FROM fluid_spike_files WHERE path = ?").run(target);
  if (children.length) {
    db()
      .query("DELETE FROM fluid_spike_files WHERE path > ? AND path < ?")
      .run(prefix, upperBound);
  }
}

function fileStats(entry: StoredPath) {
  const directory = entry.kind === "directory";
  const symlink = entry.kind === "symlink";
  const contents = entry.contents ? Buffer.from(entry.contents) : undefined;
  const size = contents?.length ?? Buffer.byteLength(entry.link_target ?? "");
  const mtime = new Date(entry.mtime_ms);
  return {
    dev: 0,
    ino: 0,
    mode: entry.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    atime: mtime,
    mtime,
    ctime: mtime,
    birthtime: mtime,
    atimeMs: entry.mtime_ms,
    mtimeMs: entry.mtime_ms,
    ctimeMs: entry.mtime_ms,
    birthtimeMs: entry.mtime_ms,
    isFile: () => entry.kind === "file",
    isDirectory: () => directory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => symlink,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

async function stat(path: string | URL): Promise<ReturnType<typeof fileStats>> {
  const entry = resolveEntry(path);
  if (!entry)
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: "ENOENT",
    });
  return fileStats(entry);
}

async function lstat(
  path: string | URL,
): Promise<ReturnType<typeof fileStats>> {
  const entry = resolveEntry(path, false);
  if (!entry)
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: "ENOENT",
    });
  return fileStats(entry);
}

async function readdir(
  path: string | URL,
  _options?: { withFileTypes?: boolean },
): Promise<string[]> {
  const directory = resolveEntry(path);
  if (!directory) {
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: "ENOENT",
    });
  }
  if (directory.kind !== "directory") {
    throw Object.assign(new Error(`ENOTDIR: ${String(path)}`), {
      code: "ENOTDIR",
    });
  }
  const rows = db()
    .query("SELECT basename, kind FROM fluid_spike_files WHERE parent_path = ?")
    .all(directory.path) as Array<{
    basename: string;
    kind: StoredPath["kind"];
  }>;
  return rows.map(({ basename: name }) => name);
}

async function readlink(
  path: string | URL,
  options?: ReadlinkOptions,
): Promise<string | Buffer> {
  const entry = lookup(canonical(path));
  if (!entry || entry.kind !== "symlink" || entry.link_target === null) {
    throw Object.assign(new Error(`EINVAL: ${String(path)}`), {
      code: "EINVAL",
    });
  }
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding === "buffer"
    ? Buffer.from(entry.link_target)
    : entry.link_target;
}

async function symlink(target: string, path: string | URL): Promise<void> {
  const linkPath = canonical(path);
  if (lookup(linkPath)) {
    throw Object.assign(new Error(`EEXIST: ${linkPath}`), { code: "EEXIST" });
  }
  await mkdir(dirname(linkPath), { recursive: true });
  db()
    .query(
      `INSERT INTO fluid_spike_files(
         path, parent_path, basename, kind, contents, link_target, mode, mtime_ms
       ) VALUES (?, ?, ?, 'symlink', NULL, ?, 41471, ?)`,
    )
    .run(linkPath, dirname(linkPath), basename(linkPath), target, Date.now());
}

export const sqliteFs = {
  promises: {
    mkdir,
    readFile,
    writeFile,
    rmdir,
    unlink,
    stat,
    lstat,
    readdir,
    readlink,
    symlink,
  },
};
