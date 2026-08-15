import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cli/lib/delta-upgrade", () => ({
  attemptDeltaUpgrade: vi.fn(async () => null),
}));

import type { LifecycleLock } from "../src/lifecycle-lock";
import { getPlatformBinaryName } from "../src/cli/lib/binary";
import { downloadBinaryToTemp } from "../src/cli/lib/upgrade";

const originalFetch = globalThis.fetch;
const originalConfigDir = process.env.LORE_CONFIG_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConfigDir === undefined) delete process.env.LORE_CONFIG_DIR;
  else process.env.LORE_CONFIG_DIR = originalConfigDir;
  vi.restoreAllMocks();
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
  return { binary, executable, fetchMock, lifecycleLock, version };
}

describe("stable upgrade artifact authentication", () => {
  it("installs a download matching publisher checksum metadata", async () => {
    const { binary, executable, lifecycleLock, version } = fixture();

    const result = await downloadBinaryToTemp(
      version,
      lifecycleLock,
      undefined,
      false,
      executable,
    );

    expect(readFileSync(result.tempBinaryPath)).toEqual(binary);
  });

  it("fails closed before binary download when checksum metadata is missing", async () => {
    const { executable, fetchMock, lifecycleLock, version } = fixture({
      includeChecksums: false,
    });

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
      ),
    ).rejects.toThrow(/checksum metadata/i);
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith(".gz")),
    ).toBe(false);
  });

  it("rejects and removes a stable binary whose checksum mismatches", async () => {
    const { executable, lifecycleLock, version } = fixture({
      expectedBinarySha256: "0".repeat(64),
    });

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
      ),
    ).rejects.toThrow(/binary checksum mismatch/i);
    expect(() => readFileSync(`${executable}.download`)).toThrow();
  });

  it("rejects checksum metadata that differs from its GitHub asset digest", async () => {
    const { executable, fetchMock, lifecycleLock, version } = fixture({
      tamperChecksums: true,
    });

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        false,
        executable,
      ),
    ).rejects.toThrow(/checksum metadata digest mismatch/i);
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith(".gz")),
    ).toBe(false);
  });

  it("keeps pre-checksum releases installable when metadata is absent", async () => {
    const { binary, executable, lifecycleLock, version } = fixture({
      version: "0.40.0",
      includeChecksums: false,
    });

    const result = await downloadBinaryToTemp(
      version,
      lifecycleLock,
      undefined,
      false,
      executable,
    );

    expect(readFileSync(result.tempBinaryPath)).toEqual(binary);
  });

  it("fails closed on a new stable release in offline mode", async () => {
    const { executable, fetchMock, lifecycleLock, version } = fixture();

    await expect(
      downloadBinaryToTemp(
        version,
        lifecycleLock,
        undefined,
        "explicit",
        executable,
      ),
    ).rejects.toThrow(/publisher checksum metadata is unavailable/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
