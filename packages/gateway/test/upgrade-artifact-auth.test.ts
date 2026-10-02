import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cli/lib/delta-upgrade", () => ({
  attemptDeltaUpgrade: vi.fn(async () => null),
}));

import type { LifecycleLock } from "../src/lifecycle-lock";
import { getPlatformBinaryName } from "../src/cli/lib/binary";
import { downloadBinaryToTemp } from "../src/cli/lib/upgrade";
import {
  closeUpgradeDownloadDirectory,
  openUpgradeDownloadDirectory,
  type UpgradeDownloadDirectory,
} from "../src/cli/lib/upgrade-download";

const originalFetch = globalThis.fetch;
const originalConfigDir = process.env.LORE_CONFIG_DIR;
const temporaryDirectories: string[] = [];
const openedDirectories: UpgradeDownloadDirectory[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConfigDir === undefined) delete process.env.LORE_CONFIG_DIR;
  else process.env.LORE_CONFIG_DIR = originalConfigDir;
  vi.restoreAllMocks();
  for (const directory of openedDirectories.splice(0)) {
    closeUpgradeDownloadDirectory(directory);
  }
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function fixture(
  options: {
    version?: string;
    expectedBinarySha256?: string;
    includeChecksums?: boolean;
    tamperChecksums?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lore-upgrade-auth-"));
  temporaryDirectories.push(root);
  process.env.LORE_CONFIG_DIR = join(root, "config");
  mkdirSync(process.env.LORE_CONFIG_DIR);
  const privateRoot = join(root, "private-download");
  mkdirSync(privateRoot, { mode: 0o700 });
  const downloadDirectory = openUpgradeDownloadDirectory(privateRoot);
  openedDirectories.push(downloadDirectory);
  const executable = join(
    root,
    process.platform === "win32" ? "lore.exe" : "lore",
  );
  writeFileSync(executable, "old binary");
  const version = options.version ?? "0.40.1";
  const filename = getPlatformBinaryName();
  const binary = Buffer.from("authenticated replacement binary");
  const compressed = gzipSync(binary);
  const checksums = [
    `${options.expectedBinarySha256 ?? sha256(binary)}  ${filename}`,
    `${sha256(compressed)}  ${filename}.gz`,
    "",
  ].join("\n");
  const checksumsDigest = options.tamperChecksums
    ? sha256("different checksum metadata")
    : sha256(checksums);
  const checksumsUrl = `https://github.com/BYK/loreai/releases/download/${version}/lore-checksums.txt`;
  const release = {
    tag_name: version,
    assets:
      options.includeChecksums === false
        ? []
        : [
            {
              name: "lore-checksums.txt",
              browser_download_url: checksumsUrl,
              digest: `sha256:${checksumsDigest}`,
            },
          ],
  };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes(`/releases/tags/${version}`)) {
      return Response.json(release);
    }
    if (url === checksumsUrl) return new Response(checksums);
    if (url.endsWith(`${filename}.gz`)) return new Response(compressed);
    if (url.endsWith(filename)) return new Response(binary);
    throw new Error(`Unexpected URL: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const lifecycleLock = {
    assertOwned: vi.fn(),
  } as unknown as LifecycleLock;
  return {
    binary,
    executable,
    fetchMock,
    lifecycleLock,
    version,
    privateRoot,
    downloadDirectory,
  };
}

describe("stable upgrade artifact authentication", () => {
  it("installs a download matching publisher checksum metadata", async () => {
    const { binary, executable, lifecycleLock, version, downloadDirectory } =
      fixture();

    const result = await downloadBinaryToTemp(
      version,
      lifecycleLock,
      undefined,
      false,
      executable,
      downloadDirectory,
    );

    expect(readFileSync(result.tempBinaryPath)).toEqual(binary);
  });

  it("fails closed before binary download when checksum metadata is missing", async () => {
    const { executable, fetchMock, lifecycleLock, version, downloadDirectory } =
      fixture({
        includeChecksums: false,
      });

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
        downloadDirectory,
      ),
    ).rejects.toThrow(/checksum metadata/i);
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith(".gz")),
    ).toBe(false);
  });

  it("rejects a mismatched stable binary without publishing it", async () => {
    const {
      executable,
      lifecycleLock,
      version,
      privateRoot,
      downloadDirectory,
    } = fixture({
      expectedBinarySha256: "0".repeat(64),
    });

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
        downloadDirectory,
      ),
    ).rejects.toThrow(/binary checksum mismatch/i);
    expect(readFileSync(executable, "utf8")).toBe("old binary");
    const namedOutput = join(privateRoot, `${basename(executable)}.download`);
    if (process.platform === "darwin") {
      expect(readFileSync(namedOutput)).toEqual(
        Buffer.from("authenticated replacement binary"),
      );
    } else {
      expect(() => readFileSync(namedOutput)).toThrow();
    }
    openedDirectories.splice(openedDirectories.indexOf(downloadDirectory), 1);
    closeUpgradeDownloadDirectory(downloadDirectory);
    if (process.platform === "darwin") {
      expect(readFileSync(namedOutput)).toHaveLength(0);
    } else {
      expect(() => readFileSync(namedOutput)).toThrow();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "retains and truncates a rejected Darwin download without unlinking its name",
    async () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      if (!platform) throw new Error("Missing platform descriptor");
      Object.defineProperty(process, "platform", { value: "darwin" });
      try {
        const {
          binary,
          executable,
          lifecycleLock,
          version,
          privateRoot,
          downloadDirectory,
        } = fixture({ expectedBinarySha256: "0".repeat(64) });
        await expect(
          downloadBinaryToTemp(
            version,
            lifecycleLock,
            undefined,
            false,
            executable,
            downloadDirectory,
          ),
        ).rejects.toThrow(/binary checksum mismatch/i);
        const namedOutput = join(
          privateRoot,
          `${basename(executable)}.download`,
        );
        expect(readFileSync(namedOutput)).toEqual(binary);
        openedDirectories.splice(
          openedDirectories.indexOf(downloadDirectory),
          1,
        );
        closeUpgradeDownloadDirectory(downloadDirectory);
        expect(readFileSync(namedOutput)).toHaveLength(0);
        expect(readFileSync(executable, "utf8")).toBe("old binary");
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    },
  );

  it("preserves an unrelated output planted after checksum metadata resolves", async () => {
    const {
      executable,
      lifecycleLock,
      version,
      privateRoot,
      downloadDirectory,
    } = fixture();
    const output = join(privateRoot, `${basename(executable)}.download`);
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const result = await fetchBefore(input);
      if (requestUrl(input).endsWith("lore-checksums.txt"))
        writeFileSync(output, "keep this");
      return result;
    }) as unknown as typeof fetch;
    if (process.platform === "linux") {
      const result = await downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
        downloadDirectory,
      );
      expect(readFileSync(result.tempBinaryPath)).toEqual(
        Buffer.from("authenticated replacement binary"),
      );
    } else {
      await expect(
        downloadBinaryToTemp(
          version,
          lifecycleLock,
          undefined,
          false,
          executable,
          downloadDirectory,
        ),
      ).rejects.toThrow();
    }
    expect(readFileSync(output, "utf8")).toBe("keep this");
  });

  it("preserves a planted output name when publisher checksum fails", async () => {
    const {
      executable,
      lifecycleLock,
      version,
      privateRoot,
      downloadDirectory,
    } = fixture({ expectedBinarySha256: "0".repeat(64) });
    const output = join(privateRoot, `${basename(executable)}.download`);
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const result = await fetchBefore(input);
      if (requestUrl(input).endsWith(`${getPlatformBinaryName()}.gz`)) {
        if (process.platform === "darwin")
          renameSync(output, `${output}.opened`);
        writeFileSync(output, "keep this");
      }
      return result;
    }) as unknown as typeof fetch;
    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
        downloadDirectory,
      ),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(readFileSync(output, "utf8")).toBe("keep this");
  });

  it("rejects checksum metadata that differs from its GitHub asset digest", async () => {
    const { executable, fetchMock, lifecycleLock, version, downloadDirectory } =
      fixture({
        tamperChecksums: true,
      });

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
        downloadDirectory,
      ),
    ).rejects.toThrow(/checksum metadata digest mismatch/i);
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith(".gz")),
    ).toBe(false);
  });

  it("keeps pre-checksum releases installable when metadata is absent", async () => {
    const { binary, executable, lifecycleLock, version, downloadDirectory } =
      fixture({
        version: "0.40.0",
        includeChecksums: false,
      });

    const result = await downloadBinaryToTemp(
      version,
      lifecycleLock,
      undefined,
      false,
      executable,
      downloadDirectory,
    );

    expect(readFileSync(result.tempBinaryPath)).toEqual(binary);
  });

  it("fails closed on a new stable release in offline mode", async () => {
    const { executable, fetchMock, lifecycleLock, version, downloadDirectory } =
      fixture();

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        "explicit",
        executable,
        downloadDirectory,
      ),
    ).rejects.toThrow(/publisher checksum metadata is unavailable/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "never writes or chmods a swapped download symlink while permissions change mid-stream",
    async () => {
      const { binary, executable, lifecycleLock, version, downloadDirectory } =
        fixture();
      const installDir = dirname(executable);
      const victim = join(installDir, "victim");
      writeFileSync(victim, "do not change", { mode: 0o600 });
      const originalFetch = globalThis.fetch;
      const compressed = gzipSync(binary);
      const oldDownload = `${executable}.download`;
      let pulled = 0;
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        if (!requestUrl(input).endsWith(`${getPlatformBinaryName()}.gz`)) {
          return originalFetch(input);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled++ === 0) {
                controller.enqueue(compressed.subarray(0, 10));
                return;
              }
              chmodSync(installDir, 0o775);
              try {
                unlinkSync(oldDownload);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                  throw error;
                }
              }
              symlinkSync(victim, oldDownload);
              controller.enqueue(compressed.subarray(10));
              controller.close();
            },
          }),
        );
      }) as unknown as typeof fetch;

      const result = await downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
        downloadDirectory,
      );

      expect(pulled).toBe(2);
      expect(readFileSync(result.tempBinaryPath)).toEqual(binary);
      expect(readFileSync(victim, "utf8")).toBe("do not change");
      expect(lstatSync(victim).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "never writes or chmods through a replaced private download directory",
    async () => {
      const {
        executable,
        lifecycleLock,
        version,
        privateRoot,
        binary,
        downloadDirectory,
      } = fixture();
      const moved = `${privateRoot}-moved`;
      const victim = join(dirname(executable), "private-victim");
      writeFileSync(victim, "do not change", { mode: 0o600 });
      const originalFetch = globalThis.fetch;
      const compressed = gzipSync(binary);
      let pulled = 0;
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        if (!requestUrl(input).endsWith(`${getPlatformBinaryName()}.gz`)) {
          return originalFetch(input);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled++ === 0) {
                controller.enqueue(compressed.subarray(0, 10));
                return;
              }
              renameSync(privateRoot, moved);
              temporaryDirectories.push(moved);
              mkdirSync(privateRoot, { mode: 0o700 });
              symlinkSync(
                victim,
                join(privateRoot, `${basename(executable)}.download`),
              );
              controller.enqueue(compressed.subarray(10));
              controller.close();
            },
          }),
        );
      }) as unknown as typeof fetch;

      try {
        await downloadBinaryToTemp(
          version,
          lifecycleLock,
          undefined,
          false,
          executable,
          downloadDirectory,
        );
      } catch {
        // Refusing a replaced directory is also safe.
      }
      expect(pulled).toBe(2);
      expect(readFileSync(victim, "utf8")).toBe("do not change");
      expect(lstatSync(victim).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "never follows a swapped file inside the opened private directory",
    async () => {
      const {
        executable,
        lifecycleLock,
        version,
        privateRoot,
        binary,
        downloadDirectory,
      } = fixture();
      const victim = join(dirname(executable), "inner-victim");
      writeFileSync(victim, "do not change", { mode: 0o600 });
      const originalFetch = globalThis.fetch;
      const compressed = gzipSync(binary);
      const output = join(privateRoot, `${basename(executable)}.download`);
      let pulled = 0;
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        if (!requestUrl(input).endsWith(`${getPlatformBinaryName()}.gz`)) {
          return originalFetch(input);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled++ === 0) {
                controller.enqueue(compressed.subarray(0, 10));
                return;
              }
              chmodSync(privateRoot, 0o775);
              try {
                unlinkSync(output);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                  throw error;
                }
              }
              symlinkSync(victim, output);
              controller.enqueue(compressed.subarray(10));
              controller.close();
            },
          }),
        );
      }) as unknown as typeof fetch;

      try {
        await downloadBinaryToTemp(
          version,
          lifecycleLock,
          undefined,
          false,
          executable,
          downloadDirectory,
        );
      } catch {
        // Refusal is safe as long as it cannot write or chmod the victim.
      }
      expect(pulled).toBe(2);
      expect(readFileSync(victim, "utf8")).toBe("do not change");
      expect(lstatSync(victim).mode & 0o777).toBe(0o600);
    },
  );
});
