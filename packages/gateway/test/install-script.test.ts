import { createHash } from "node:crypto";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLifecycleLock,
  createUninstallTombstone,
  LifecycleLockBusyError,
  type LifecycleLockOwner,
} from "../src/lifecycle-lock";
import { standaloneInstallProvenance } from "../src/cli/uninstall";

const installer = resolve(import.meta.dirname, "../../website/public/install");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): { home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "lore-installer-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(home);
  mkdirSync(fakeBin);

  const binary = Buffer.from(
    '#!/bin/sh\n[ "${1:-}" = "--version" ] && echo 1.2.3\n',
  );
  const archive = join(root, "lore.gz");
  const compressed = gzipSync(binary);
  writeFileSync(archive, compressed);
  const checksums = join(root, "lore-checksums.txt");
  const binarySha256 = createHash("sha256").update(binary).digest("hex");
  const archiveSha256 = createHash("sha256").update(compressed).digest("hex");
  writeFileSync(
    checksums,
    [
      `${binarySha256}  lore-linux-x64`,
      `${archiveSha256}  lore-linux-x64.gz`,
      `${binarySha256}  lore-windows-x64.exe`,
      `${archiveSha256}  lore-windows-x64.exe.gz`,
      "",
    ].join("\n"),
  );
  const releaseMetadata = join(root, "release.json");
  writeFileSync(
    releaseMetadata,
    JSON.stringify({
      tag_name: "1.2.3",
      assets: [
        {
          name: "lore-checksums.txt",
          digest: `sha256:${createHash("sha256")
            .update(readFileSync(checksums))
            .digest("hex")}`,
          browser_download_url:
            "https://github.com/BYK/loreai/releases/download/1.2.3/lore-checksums.txt",
        },
      ],
    }),
  );
  writeExecutable(
    join(fakeBin, "curl"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *api.github.com*/releases/tags/*) cat "$LORE_TEST_RELEASE_METADATA" ;;',
      '  *lore-checksums.txt*) cat "$LORE_TEST_CHECKSUMS" ;;',
      '  *.gz*) cat "$LORE_TEST_ARCHIVE" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(fakeBin, "uname"),
    [
      "#!/bin/sh",
      'case "${1:-}" in',
      "  -s) printf '%s\\n' \"${LORE_TEST_UNAME_S:-Linux}\" ;;",
      "  -m) printf '%s\\n' \"${LORE_TEST_UNAME_M:-x86_64}\" ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(fakeBin, "cygpath"),
    [
      "#!/bin/sh",
      '[ "${1:-}" = "-w" ] || exit 1',
      "printf '%s\\n' \"$LORE_TEST_WINDOWS_PATH\"",
      "",
    ].join("\n"),
  );

  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      LORE_TEST_ARCHIVE: archive,
      LORE_TEST_CHECKSUMS: checksums,
      LORE_TEST_RELEASE_METADATA: releaseMetadata,
      LORE_VERSION: "1.2.3",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SHELL: "/bin/bash",
    },
  };
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o755 });
}

function realCommand(command: string): string {
  const result = spawnSync("which", [command], {
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Could not locate ${command}`);
  return result.stdout.trim();
}

function runInstaller(
  home: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): SpawnSyncReturns<string> {
  return spawnSync("bash", [installer, ...args], {
    cwd: home,
    env,
    encoding: "utf8",
  });
}

function uninstallTombstone(token: string): string {
  return `${JSON.stringify({
    version: 1,
    token,
    createdAt: "2026-08-12T00:00:00.000Z",
  })}\n`;
}

function expectedReceipt(executable: string, pathInstallDir: string): string {
  const info = lstatSync(executable, { bigint: true });
  return [
    "lore-install-receipt-v3",
    `executable=${executable}`,
    `path-install-dir=${pathInstallDir}`,
    `sha256=${createHash("sha256").update(readFileSync(executable)).digest("hex")}`,
    `device=${info.dev}`,
    `inode=${info.ino}`,
    `size=${info.size}`,
    `mtime-ns=${info.mtimeNs}`,
    "",
  ].join("\n");
}

function processStartTicks(pid = process.pid): string {
  const processStat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return (
    processStat
      .slice(processStat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19] ?? ""
  );
}

describe("hosted installer", () => {
  it("passes Bash syntax validation", () => {
    const syntax = spawnSync("bash", ["-n", installer], {
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("publishes a v3 receipt bound to the executable generation", () => {
    const { home, env } = fixture();
    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status, install.stderr).toBe(0);
    const executable = join(home, ".local", "bin", "lore");
    expect(readFileSync(join(home, ".lore", "install-path"), "utf8")).toBe(
      expectedReceipt(executable, join(home, ".local", "bin")),
    );
    expect(readFileSync(join(home, ".lore", "channel"), "utf8")).toBe("stable");
    expect(
      standaloneInstallProvenance(executable, { seaBinary: true, home }),
    ).toMatchObject({
      hostedInstall: true,
      pathInstallDir: join(home, ".local", "bin"),
      executableIdentity: {
        sha256: createHash("sha256")
          .update(readFileSync(executable))
          .digest("hex"),
      },
      receiptIdentity: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it("rejects a same-content replacement executable generation", () => {
    const { home, env } = fixture();
    const install = runInstaller(home, env, "--no-modify-path");
    expect(install.status, install.stderr).toBe(0);

    const executable = join(home, ".local", "bin", "lore");
    const replacement = join(home, ".local", "bin", "replacement-lore");
    writeFileSync(replacement, readFileSync(executable), { mode: 0o755 });
    renameSync(replacement, executable);

    expect(
      standaloneInstallProvenance(executable, { seaBinary: true, home }),
    ).toEqual({ hostedInstall: false });
  });

  it("clears the observed uninstall generation after a verified fresh install", async () => {
    const { home, env } = fixture();
    const stateDir = join(home, ".lore");
    const tombstone = join(stateDir, "uninstalled.json");
    const lock = await acquireLifecycleLock("uninstall", {
      lockPath: join(stateDir, "lifecycle.lock"),
    });
    createUninstallTombstone(lock);
    lock.release();

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status, install.stderr).toBe(0);
    expect(existsSync(tombstone)).toBe(false);
    expect(
      standaloneInstallProvenance(join(home, ".local", "bin", "lore"), {
        seaBinary: true,
        home,
      }),
    ).toMatchObject({ hostedInstall: true });
  });

  it("publishes a lifecycle owner interoperable with the gateway lock", async () => {
    const { home, env } = fixture();
    const capturedOwner = join(dirname(home), "captured-owner.json");
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    writeExecutable(
      join(fakeBin, "curl"),
      [
        "#!/bin/sh",
        'cp "$HOME/.lore/lifecycle.lock/owner.json" "$LORE_TEST_OWNER_CAPTURE"',
        'case "$*" in',
        '  *api.github.com*/releases/tags/*) cat "$LORE_TEST_RELEASE_METADATA" ;;',
        '  *lore-checksums.txt*) cat "$LORE_TEST_CHECKSUMS" ;;',
        '  *.gz*) cat "$LORE_TEST_ARCHIVE" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    env.LORE_TEST_OWNER_CAPTURE = capturedOwner;

    const install = runInstaller(home, env, "--no-modify-path");
    expect(install.status, install.stderr).toBe(0);

    const lockPath = join(home, ".lore", "lifecycle.lock");
    const owner = JSON.parse(
      readFileSync(capturedOwner, "utf8"),
    ) as LifecycleLockOwner;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    });

    await expect(
      acquireLifecycleLock("uninstall", {
        lockPath,
        timeoutMs: 0,
        now: () => 0,
        pid: process.pid,
        processIdentity: "test:contender",
        processStartedAt: "2026-08-12T00:00:00.000Z",
        inspectProcess: () => ({
          state: "alive",
          identity: owner.processIdentity,
        }),
      }),
    ).rejects.toBeInstanceOf(LifecycleLockBusyError);
  });

  it("clears only the uninstall generation observed before lock acquisition", () => {
    const { home, env } = fixture();
    const stateDir = join(home, ".lore");
    const tombstone = join(stateDir, "uninstalled.json");
    const lockPath = join(stateDir, "lifecycle.lock");
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(tombstone, uninstallTombstone("o".repeat(43)), {
      mode: 0o600,
    });

    writeExecutable(
      join(fakeBin, "mkdir"),
      [
        "#!/bin/sh",
        "set -eu",
        'last=""',
        'for arg in "$@"; do last=$arg; done',
        'if [ "$last" = "$LORE_TEST_LOCK_PATH" ]; then',
        '  printf "%s" "$LORE_TEST_NEW_TOMBSTONE" > "$LORE_TEST_TOMBSTONE"',
        '  chmod 600 "$LORE_TEST_TOMBSTONE"',
        "fi",
        'exec "$LORE_TEST_REAL_MKDIR" "$@"',
        "",
      ].join("\n"),
    );
    env.LORE_TEST_REAL_MKDIR = realCommand("mkdir");
    env.LORE_TEST_LOCK_PATH = lockPath;
    env.LORE_TEST_TOMBSTONE = tombstone;
    env.LORE_TEST_NEW_TOMBSTONE = uninstallTombstone("n".repeat(43));

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("stale hosted-install invocation");
    expect(readFileSync(tombstone, "utf8")).toBe(
      uninstallTombstone("n".repeat(43)),
    );
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(false);
  });

  it("preserves a successor marker published during expected-token clearing", async () => {
    const { home, env } = fixture();
    const stateDir = join(home, ".lore");
    const tombstone = join(stateDir, "uninstalled.json");
    const lock = await acquireLifecycleLock("uninstall", {
      lockPath: join(stateDir, "lifecycle.lock"),
    });
    createUninstallTombstone(lock);
    lock.release();
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    writeExecutable(
      join(fakeBin, "mv"),
      [
        "#!/bin/sh",
        "set -eu",
        '"$LORE_TEST_REAL_MV" "$@"',
        'if [ "${1:-}" = "$LORE_TEST_TOMBSTONE" ]; then',
        '  printf "%s" "$LORE_TEST_NEW_TOMBSTONE" > "$LORE_TEST_TOMBSTONE"',
        '  chmod 600 "$LORE_TEST_TOMBSTONE"',
        "fi",
        "",
      ].join("\n"),
    );
    env.LORE_TEST_REAL_MV = realCommand("mv");
    env.LORE_TEST_TOMBSTONE = tombstone;
    env.LORE_TEST_NEW_TOMBSTONE = uninstallTombstone("s".repeat(43));

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("successor uninstall marker");
    expect(readFileSync(tombstone, "utf8")).toBe(
      uninstallTombstone("s".repeat(43)),
    );
  });

  it("fails lock contention before binary, receipt, channel, or profile mutation", () => {
    const { home, env } = fixture();
    const profile = join(home, ".bashrc");
    const lock = join(home, ".lore", "lifecycle.lock");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(profile, "export KEEP_ME=1\n");
    const token = "o".repeat(43);
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        operation: "uninstall",
        createdAt: "2000-01-01T00:00:00.000Z",
        processStartedAt: "2000-01-01T00:00:00.000Z",
        processIdentity: `unverified:${token}`,
      })}\n`,
      { mode: 0o600 },
    );

    const install = runInstaller(home, env);

    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("lifecycle is busy");
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(false);
    expect(existsSync(join(home, ".lore", "install-path"))).toBe(false);
    expect(existsSync(join(home, ".lore", "channel"))).toBe(false);
    expect(readFileSync(profile, "utf8")).toBe("export KEEP_ME=1\n");
  });

  it("keeps a live unix owner busy when ps lstart renders in a different timezone", () => {
    const { home, env } = fixture();
    const lock = join(home, ".lore", "lifecycle.lock");
    const token = "z".repeat(43);
    const utcStart = spawnSync(
      "ps",
      ["-o", "lstart=", "-p", String(process.pid)],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC" },
      },
    ).stdout.trim();
    const localStart = spawnSync(
      "ps",
      ["-o", "lstart=", "-p", String(process.pid)],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: "Pacific/Honolulu" },
      },
    ).stdout.trim();
    expect(localStart).not.toBe(utcStart);
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        operation: "uninstall",
        createdAt: "2026-08-12T00:00:00.000Z",
        processStartedAt: utcStart,
        processIdentity: `unix:${utcStart}`,
      })}\n`,
      { mode: 0o600 },
    );

    const install = runInstaller(
      home,
      { ...env, TZ: "Pacific/Honolulu" },
      "--no-modify-path",
    );

    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("lifecycle is busy");
    expect(
      JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token,
    ).toBe(token);
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(false);
  });

  it("fails closed when checksum metadata is missing for a new release", () => {
    const { home, env } = fixture();
    const metadata = env.LORE_TEST_RELEASE_METADATA;
    if (!metadata) throw new Error("release metadata fixture is missing");
    writeFileSync(metadata, JSON.stringify({ tag_name: "1.2.3", assets: [] }));

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("checksum metadata");
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(false);
  });

  it("keeps a pre-checksum stable release installable without metadata", () => {
    const { home, env } = fixture();
    const metadata = env.LORE_TEST_RELEASE_METADATA;
    if (!metadata) throw new Error("release metadata fixture is missing");
    env.LORE_VERSION = "0.40.0";
    writeFileSync(metadata, JSON.stringify({ tag_name: "0.40.0", assets: [] }));

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status, install.stderr).toBe(0);
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(true);
  });

  it("fails closed before execution when the stable binary checksum mismatches", () => {
    const { home, env } = fixture();
    const checksums = env.LORE_TEST_CHECKSUMS;
    const metadata = env.LORE_TEST_RELEASE_METADATA;
    if (!checksums || !metadata) throw new Error("checksum fixture is missing");
    const contents = readFileSync(checksums, "utf8").replace(
      /^[a-f0-9]{64}  lore-linux-x64$/m,
      `${"0".repeat(64)}  lore-linux-x64`,
    );
    writeFileSync(checksums, contents);
    const release: {
      assets: Array<{ digest: string }>;
    } = JSON.parse(readFileSync(metadata, "utf8"));
    const checksumAsset = release.assets[0];
    if (!checksumAsset) throw new Error("checksum asset fixture is missing");
    checksumAsset.digest = `sha256:${createHash("sha256")
      .update(contents)
      .digest("hex")}`;
    writeFileSync(metadata, JSON.stringify(release));

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("checksum mismatch");
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(false);
  });

  it("rejects a tampered nightly blob against its OCI manifest digest", () => {
    const { home, env } = fixture();
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    const publishedDigest = createHash("sha256")
      .update("different published blob")
      .digest("hex");
    env.LORE_VERSION = "nightly";
    env.LORE_TEST_NIGHTLY_MANIFEST = JSON.stringify({
      schemaVersion: 2,
      layers: [
        {
          digest: `sha256:${publishedDigest}`,
          annotations: {
            "org.opencontainers.image.title": "lore-linux-x64.gz",
          },
        },
      ],
      annotations: { version: "0.41.0-dev.1" },
    });
    writeExecutable(
      join(fakeBin, "curl"),
      [
        "#!/bin/sh",
        'case "$*" in',
        "  *ghcr.io/token*) printf '%s' '{\"token\":\"test-token\"}' ;;",
        "  *manifests/nightly*) printf '%s' \"$LORE_TEST_NIGHTLY_MANIFEST\" ;;",
        "  *ghcr.io*/blobs/*) printf '\\n%s\\n' 'https://blob.test/lore.gz' ;;",
        '  *blob.test/lore.gz*) cat "$LORE_TEST_ARCHIVE" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("OCI blob digest mismatch");
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(false);
  });

  it("recovers an incomplete lock after its initialization lease", () => {
    const { home, env } = fixture();
    const lock = join(home, ".lore", "lifecycle.lock");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    const expired = new Date(Date.now() - 60_000);
    utimesSync(lock, expired, expired);

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status, install.stderr).toBe(0);
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(true);
  });

  it("recovers a SIGKILL between lock mkdir and owner publication", async () => {
    const { home, env } = fixture();
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    const stateDir = join(home, ".lore");
    const lock = join(stateDir, "lifecycle.lock");
    writeExecutable(
      join(fakeBin, "mkdir"),
      [
        "#!/bin/sh",
        "set -eu",
        'last=""',
        'for arg in "$@"; do last=$arg; done',
        'if [ "$last" = "$LORE_TEST_LOCK_PATH" ] && [ "${LORE_TEST_KILL_AFTER_MKDIR:-}" = 1 ]; then',
        '  "$LORE_TEST_REAL_MKDIR" "$@"',
        '  kill -KILL "$LORE_TEST_INSTALLER_PID"',
        "  exit 0",
        "fi",
        'exec "$LORE_TEST_REAL_MKDIR" "$@"',
        "",
      ].join("\n"),
    );
    env.LORE_TEST_REAL_MKDIR = realCommand("mkdir");
    env.LORE_TEST_LOCK_PATH = lock;
    env.LORE_TEST_KILL_AFTER_MKDIR = "1";

    const killed = spawn(
      "bash",
      [
        "-c",
        'export LORE_TEST_INSTALLER_PID=$$; exec bash "$1" --no-modify-path',
        "bash",
        installer,
      ],
      { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    await expect(
      new Promise<NodeJS.Signals | null>((resolveExit, rejectExit) => {
        killed.once("error", rejectExit);
        killed.once("exit", (_code, signal) => resolveExit(signal));
      }),
    ).resolves.toBe("SIGKILL");

    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(lock, "owner.json"))).toBe(false);
    const initClaims = readdirSync(stateDir).filter((entry) =>
      entry.startsWith(".lifecycle.lock.init."),
    );
    expect(initClaims).toHaveLength(1);
    const token = initClaims[0]?.slice(".lifecycle.lock.init.".length);
    if (!token) throw new Error("initialization claim token is missing");
    const expired = new Date(Date.now() - 60_000);
    utimesSync(lock, expired, expired);

    const install = runInstaller(
      home,
      { ...env, LORE_TEST_KILL_AFTER_MKDIR: "" },
      "--no-modify-path",
    );

    expect(install.status, install.stderr).toBe(0);
    expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(true);
    expect(
      existsSync(join(stateDir, `.lifecycle.lock.claim.init.${token}`)),
    ).toBe(true);
  });

  it.skipIf(process.platform !== "linux")(
    "reclaims a live PID whose process generation was reused",
    () => {
      const { home, env } = fixture();
      const lock = join(home, ".lore", "lifecycle.lock");
      const bootId = readFileSync(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      ).trim();
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(lock, "owner.json"),
        `${JSON.stringify({
          version: 1,
          token: "r".repeat(43),
          pid: process.pid,
          operation: "uninstall",
          createdAt: "2026-08-12T00:00:00.000Z",
          processStartedAt: "2026-08-12T00:00:00.000Z",
          processIdentity: `linux:${bootId}:1`,
        })}\n`,
        { mode: 0o600 },
      );

      const install = runInstaller(home, env, "--no-modify-path");

      expect(install.status, install.stderr).toBe(0);
      expect(existsSync(join(home, ".local", "bin", "lore"))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reclaims an installer SIGKILLed after owner publication",
    async () => {
      const { home, env } = fixture();
      const fakeBin = env.PATH?.split(":")[0];
      if (!fakeBin) throw new Error("fixture PATH is missing");
      const capturedOwner = join(dirname(home), "killed-owner.json");
      writeExecutable(
        join(fakeBin, "curl"),
        [
          "#!/bin/sh",
          "set -eu",
          'cp "$HOME/.lore/lifecycle.lock/owner.json" "$LORE_TEST_OWNER_CAPTURE"',
          'if [ "${LORE_TEST_KILL_AFTER_OWNER:-}" = 1 ]; then kill -KILL "$LORE_TEST_INSTALLER_PID"; fi',
          'case "$*" in',
          '  *api.github.com*/releases/tags/*) cat "$LORE_TEST_RELEASE_METADATA" ;;',
          '  *lore-checksums.txt*) cat "$LORE_TEST_CHECKSUMS" ;;',
          '  *.gz*) cat "$LORE_TEST_ARCHIVE" ;;',
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      env.LORE_TEST_OWNER_CAPTURE = capturedOwner;
      env.LORE_TEST_KILL_AFTER_OWNER = "1";

      const killed = spawn(
        "bash",
        [
          "-c",
          'export LORE_TEST_INSTALLER_PID=$$; exec bash "$1" --no-modify-path',
          "bash",
          installer,
        ],
        { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] },
      );
      await expect(
        new Promise<NodeJS.Signals | null>((resolveExit, rejectExit) => {
          killed.once("error", rejectExit);
          killed.once("exit", (_code, signal) => resolveExit(signal));
        }),
      ).resolves.toBe("SIGKILL");
      const deadOwner = JSON.parse(readFileSync(capturedOwner, "utf8")) as {
        token: string;
      };

      const install = runInstaller(
        home,
        { ...env, LORE_TEST_KILL_AFTER_OWNER: "" },
        "--no-modify-path",
      );

      expect(install.status, install.stderr).toBe(0);
      expect(
        existsSync(
          join(home, ".lore", `.lifecycle.lock.claim.${deadOwner.token}`),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "a delayed stale reclaimer cannot move a live successor",
    () => {
      const { home, env } = fixture();
      const fakeBin = env.PATH?.split(":")[0];
      if (!fakeBin) throw new Error("fixture PATH is missing");
      const stateDir = join(home, ".lore");
      const lock = join(stateDir, "lifecycle.lock");
      const staleToken = "d".repeat(43);
      const successorToken = "s".repeat(43);
      const claim = join(stateDir, `.lifecycle.lock.claim.${staleToken}`);
      const moveMarker = join(dirname(home), "stale-lock-moved");
      const bootId = readFileSync(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      ).trim();
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(lock, "owner.json"),
        `${JSON.stringify({
          version: 1,
          token: staleToken,
          pid: process.pid,
          operation: "uninstall",
          createdAt: "2026-08-12T00:00:00.000Z",
          processStartedAt: "2026-08-12T00:00:00.000Z",
          processIdentity: `linux:${bootId}:1`,
        })}\n`,
        { mode: 0o600 },
      );
      writeExecutable(
        join(fakeBin, "mv"),
        [
          "#!/bin/sh",
          "set -eu",
          'previous=""',
          'current=""',
          'for arg in "$@"; do previous=$current; current=$arg; done',
          "source_path=$previous",
          "destination_path=$current",
          'if [ "$source_path" = "$LORE_TEST_LOCK" ] && [ ! -e "$LORE_TEST_MOVE_MARKER" ]; then',
          '  : > "$LORE_TEST_MOVE_MARKER"',
          '  "$LORE_TEST_REAL_MV" "$source_path" "$destination_path"',
          '  "$LORE_TEST_REAL_MKDIR" -m 700 "$LORE_TEST_LOCK"',
          '  printf \'{"version":1,"token":"%s","pid":%s,"operation":"gateway-start","createdAt":"2026-08-12T00:00:00.000Z","processStartedAt":"2026-08-12T00:00:00.000Z","processIdentity":"linux:%s:%s"}\\n\' "$LORE_TEST_SUCCESSOR_TOKEN" "$LORE_TEST_SUCCESSOR_PID" "$LORE_TEST_BOOT_ID" "$LORE_TEST_SUCCESSOR_START" > "$LORE_TEST_LOCK/owner.json"',
          '  chmod 600 "$LORE_TEST_LOCK/owner.json"',
          '  exec "$LORE_TEST_REAL_MV" "$source_path" "$destination_path/lock"',
          "fi",
          'exec "$LORE_TEST_REAL_MV" "$@"',
          "",
        ].join("\n"),
      );
      env.LORE_TEST_REAL_MV = realCommand("mv");
      env.LORE_TEST_REAL_MKDIR = realCommand("mkdir");
      env.LORE_TEST_LOCK = lock;
      env.LORE_TEST_MOVE_MARKER = moveMarker;
      env.LORE_TEST_SUCCESSOR_TOKEN = successorToken;
      env.LORE_TEST_SUCCESSOR_PID = String(process.pid);
      env.LORE_TEST_BOOT_ID = bootId;
      env.LORE_TEST_SUCCESSOR_START = processStartTicks();

      const install = runInstaller(home, env, "--no-modify-path");

      expect(install.status).not.toBe(0);
      expect(existsSync(moveMarker)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token,
      ).toBe(successorToken);
      expect(
        JSON.parse(readFileSync(join(claim, "owner.json"), "utf8")).token,
      ).toBe(staleToken);
      expect(existsSync(join(claim, "lock", "lifecycle.lock"))).toBe(true);
    },
  );

  it("does not overwrite a shell profile successor published after validation", () => {
    const { home, env } = fixture();
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    const profile = join(home, ".bashrc");
    writeFileSync(profile, "# original profile\n");
    writeExecutable(
      join(fakeBin, "mv"),
      [
        "#!/bin/sh",
        "set -eu",
        'previous=""',
        'current=""',
        'for arg in "$@"; do previous=$current; current=$arg; done',
        '"$LORE_TEST_REAL_MV" "$@"',
        'if [ "$previous" = "$LORE_TEST_PROFILE" ]; then',
        "  printf '%s\\n' '# concurrent successor' > \"$LORE_TEST_PROFILE\"",
        "fi",
        "",
      ].join("\n"),
    );
    env.LORE_TEST_REAL_MV = realCommand("mv");
    env.LORE_TEST_PROFILE = profile;

    const install = runInstaller(home, env);

    expect(install.status, install.stderr).toBe(0);
    expect(install.stderr).toContain("automatic PATH setup failed");
    expect(readFileSync(profile, "utf8")).toBe("# concurrent successor\n");
    const originalClaims = readdirSync(home).filter((name) =>
      name.startsWith(".bashrc.lore-original."),
    );
    expect(originalClaims).toHaveLength(1);
    expect(readFileSync(join(home, originalClaims[0]), "utf8")).toBe(
      "# original profile\n",
    );
  });

  it.skipIf(process.platform !== "linux")(
    "recovers a profile in a fresh process after SIGKILL immediately after its claim move",
    async () => {
      const { home, env } = fixture();
      const fakeBin = env.PATH?.split(":")[0];
      if (!fakeBin) throw new Error("fixture PATH is missing");
      const profile = join(home, ".bashrc");
      writeFileSync(profile, "# original profile\nexport KEEP_ME=1\n");
      writeExecutable(
        join(fakeBin, "mv"),
        [
          "#!/bin/sh",
          "set -eu",
          'previous=""',
          'current=""',
          'for arg in "$@"; do previous=$current; current=$arg; done',
          '"$LORE_TEST_REAL_MV" "$@"',
          'case "$current" in',
          '  "$LORE_TEST_PROFILE".lore-original.*)',
          '    if [ "${LORE_TEST_KILL_AFTER_PROFILE_CLAIM:-}" = 1 ]; then',
          '      kill -KILL "$LORE_TEST_INSTALLER_PID"',
          "    fi",
          "    ;;",
          "esac",
          "",
        ].join("\n"),
      );
      env.LORE_TEST_REAL_MV = realCommand("mv");
      env.LORE_TEST_PROFILE = profile;
      env.LORE_TEST_KILL_AFTER_PROFILE_CLAIM = "1";

      const killed = spawn(
        "bash",
        [
          "-c",
          'export LORE_TEST_INSTALLER_PID=$$; exec bash "$1"',
          "bash",
          installer,
        ],
        { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] },
      );
      await expect(
        new Promise<NodeJS.Signals | null>((resolveExit, rejectExit) => {
          killed.once("error", rejectExit);
          killed.once("exit", (_code, signal) => resolveExit(signal));
        }),
      ).resolves.toBe("SIGKILL");

      expect(existsSync(profile)).toBe(false);
      expect(
        readdirSync(home).filter((name) =>
          name.startsWith(".bashrc.lore-original."),
        ),
      ).toHaveLength(1);

      const recovered = runInstaller(home, {
        ...env,
        LORE_TEST_KILL_AFTER_PROFILE_CLAIM: "",
      });

      expect(recovered.status, recovered.stderr).toBe(0);
      const contents = readFileSync(profile, "utf8");
      expect(contents).toContain("export KEEP_ME=1");
      expect(contents.match(/# Added by lore installer/g)).toHaveLength(1);
      expect(
        readdirSync(home).filter((name) =>
          name.startsWith(".bashrc.lore-original."),
        ),
      ).toHaveLength(0);
    },
  );

  it("fails closed without publishing a profile when recovery claims are ambiguous", () => {
    const { home, env } = fixture();
    const profile = join(home, ".bashrc");
    for (const [index, contents] of ["first\n", "second\n"].entries()) {
      const staged = join(home, `.claim-${index}`);
      writeFileSync(staged, contents);
      const info = lstatSync(staged, { bigint: true });
      const sha256 = createHash("sha256").update(contents).digest("hex");
      renameSync(
        staged,
        `${profile}.lore-original.${String(index).repeat(43)}.${info.dev}.${info.ino}.${sha256}`,
      );
    }

    const install = runInstaller(home, env);

    expect(install.status, install.stderr).toBe(0);
    expect(install.stderr).toContain(
      "Refusing ambiguous shell profile recovery claims",
    );
    expect(existsSync(profile)).toBe(false);
    expect(
      readdirSync(home).filter((name) =>
        name.startsWith(".bashrc.lore-original."),
      ),
    ).toHaveLength(2);
  });

  it("quotes command substitution in the install path", () => {
    const { home, env } = fixture();
    env.LORE_INSTALL_DIR = join(home, "bin'$(touch PWNED)");

    const install = runInstaller(home, env);
    expect(install.status, install.stderr).toBe(0);

    const profile = join(home, ".bashrc");
    const source = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", 'source "$1"', "bash", profile],
      { cwd: home, env, encoding: "utf8" },
    );
    expect(source.status, source.stderr).toBe(0);
    expect(existsSync(join(home, "PWNED"))).toBe(false);
  });

  it("adds PATH when a profile merely mentions the install directory", () => {
    const { home, env } = fixture();
    const installDir = join(home, ".local", "bin");
    const profile = join(home, ".bashrc");
    writeFileSync(profile, `# tools are installed under ${installDir}\n`);

    const install = runInstaller(home, env);

    expect(install.status, install.stderr).toBe(0);
    expect(readFileSync(profile, "utf8")).toContain(
      `export PATH='${installDir}':"$PATH"`,
    );
  });

  it("restores the previous binary and receipt when channel commit fails", () => {
    const { home, env } = fixture();
    const installDir = join(home, ".local", "bin");
    const stateDir = join(home, ".lore");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(stateDir);
    writeFileSync(join(installDir, "lore"), "OLD BINARY\n");
    writeFileSync(join(stateDir, "install-path"), "OLD RECEIPT");
    mkdirSync(join(stateDir, "channel"));

    const install = runInstaller(home, env);

    expect(install.status).not.toBe(0);
    expect(readFileSync(join(installDir, "lore"), "utf8")).toBe("OLD BINARY\n");
    expect(readFileSync(join(stateDir, "install-path"), "utf8")).toBe(
      "OLD RECEIPT",
    );
  });

  it.each([
    ["a previous nightly channel", "nightly"],
    ["an absent previous channel", null],
  ])(
    "rolls back %s after late channel publication failure",
    (_label, before) => {
      const { home, env } = fixture();
      const stateDir = join(home, ".lore");
      const fakeBin = env.PATH?.split(":")[0];
      if (!fakeBin) throw new Error("fixture PATH is missing");
      mkdirSync(stateDir);
      const channel = join(stateDir, "channel");
      if (before !== null) writeFileSync(channel, before);
      writeExecutable(
        join(fakeBin, "sync"),
        [
          "#!/bin/sh",
          "set -eu",
          '"$LORE_TEST_REAL_SYNC" "$@"',
          'if [ "${1:-}" = "$LORE_TEST_CHANNEL" ] && [ ! -e "$LORE_TEST_SYNC_MARKER" ]; then',
          '  : > "$LORE_TEST_SYNC_MARKER"',
          "  exit 1",
          "fi",
          "",
        ].join("\n"),
      );
      env.LORE_TEST_REAL_SYNC = realCommand("sync");
      env.LORE_TEST_CHANNEL = channel;
      env.LORE_TEST_SYNC_MARKER = join(dirname(home), "channel-sync-failed");

      const install = runInstaller(home, env, "--no-modify-path");

      expect(install.status).not.toBe(0);
      if (before === null) {
        expect(existsSync(channel)).toBe(false);
      } else {
        expect(readFileSync(channel, "utf8")).toBe(before);
      }
    },
  );

  it("preserves a successor channel published during late-failure rollback", () => {
    const { home, env } = fixture();
    const stateDir = join(home, ".lore");
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    mkdirSync(stateDir);
    const channel = join(stateDir, "channel");
    writeFileSync(channel, "nightly");
    writeExecutable(
      join(fakeBin, "sync"),
      [
        "#!/bin/sh",
        "set -eu",
        '"$LORE_TEST_REAL_SYNC" "$@"',
        'if [ "${1:-}" = "$LORE_TEST_CHANNEL" ] && [ ! -e "$LORE_TEST_SYNC_MARKER" ]; then',
        '  : > "$LORE_TEST_SYNC_MARKER"',
        '  rm -f -- "$LORE_TEST_CHANNEL"',
        "  printf '%s' 'successor' > \"$LORE_TEST_CHANNEL\"",
        "  exit 1",
        "fi",
        "",
      ].join("\n"),
    );
    env.LORE_TEST_REAL_SYNC = realCommand("sync");
    env.LORE_TEST_CHANNEL = channel;
    env.LORE_TEST_SYNC_MARKER = join(dirname(home), "channel-successor-wrote");

    const install = runInstaller(home, env, "--no-modify-path");

    expect(install.status).not.toBe(0);
    expect(readFileSync(channel, "utf8")).toBe("successor");
  });

  it("does not roll back over a successor executable and receipt generation", () => {
    const { home, env } = fixture();
    const installDir = join(home, ".local", "bin");
    const stateDir = join(home, ".lore");
    const fakeBin = env.PATH?.split(":")[0];
    if (!fakeBin) throw new Error("fixture PATH is missing");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(stateDir);
    writeFileSync(join(installDir, "lore"), "OLD BINARY\n");
    writeFileSync(join(stateDir, "install-path"), "OLD RECEIPT");
    writeExecutable(
      join(fakeBin, "sync"),
      [
        "#!/bin/sh",
        "set -eu",
        '"$LORE_TEST_REAL_SYNC" "$@"',
        'if [ "${1:-}" = "$LORE_TEST_RECEIPT" ] && [ ! -e "$LORE_TEST_SYNC_MARKER" ]; then',
        '  : > "$LORE_TEST_SYNC_MARKER"',
        '  rm -f -- "$LORE_TEST_DEST"',
        "  printf '%s' 'REPLACEMENT BINARY' > \"$LORE_TEST_DEST\"",
        "  printf '%s' 'REPLACEMENT RECEIPT' > \"$LORE_TEST_RECEIPT\"",
        "fi",
        "",
      ].join("\n"),
    );
    env.LORE_TEST_REAL_SYNC = realCommand("sync");
    env.LORE_TEST_DEST = join(installDir, "lore");
    env.LORE_TEST_RECEIPT = join(stateDir, "install-path");
    env.LORE_TEST_SYNC_MARKER = join(dirname(home), "sync-hook-ran");

    const install = runInstaller(home, env);

    expect(install.status).not.toBe(0);
    expect(readFileSync(join(installDir, "lore"), "utf8")).toBe(
      "REPLACEMENT BINARY",
    );
    expect(readFileSync(join(stateDir, "install-path"), "utf8")).toBe(
      "REPLACEMENT RECEIPT",
    );
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
  });

  it("round-trips the native Windows executable and exact MSYS PATH directory", () => {
    const { home, env } = fixture();
    const nativeExecutable = String.raw`C:\Users\tester\.local\bin\lore.exe`;
    env.LORE_TEST_UNAME_S = "MSYS_NT-10.0";
    env.LORE_TEST_WINDOWS_PATH = nativeExecutable;

    const install = runInstaller(home, env);
    expect(install.status, install.stderr).toBe(0);

    const executable = join(home, ".local", "bin", "lore.exe");
    const pathInstallDir = join(home, ".local", "bin");
    expect(readFileSync(join(home, ".lore", "install-path"), "utf8")).toBe(
      expectedReceipt(executable, pathInstallDir).replace(
        `executable=${executable}`,
        `executable=${nativeExecutable}`,
      ),
    );
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(
      `export PATH='${pathInstallDir}':"$PATH"`,
    );
  });
});
