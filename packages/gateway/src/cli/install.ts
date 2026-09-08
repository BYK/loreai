/** Installation from a verified bootstrap; deliberately independent of CLI/DB startup. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isSea } from "node:sea";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, delimiter } from "node:path";
import { parseArgs } from "node:util";
import {
  withLifecycleLock,
  currentUninstallTombstoneToken,
  clearUninstallTombstoneForVerifiedInstall,
} from "../lifecycle-lock";
import {
  assertNoSymlinkPathComponents,
  ensureTrustedDirectory,
  readTrustedTextFile,
} from "./json-config";
import { formatStandaloneInstallReceipt } from "./install-receipt";
import {
  commitInstallTransaction,
  discardInstallStages,
  recoverInstallTransaction,
  stageInstallFile,
  stagedInstallIdentity,
  verifyInstallFiles,
  type InstallFile,
} from "./lib/install-transaction";

export interface InstallOptions {
  home?: string;
  source: string;
  channel: "stable" | "nightly";
  installDir?: string;
  configDir?: string;
  pathInstallDir?: string;
  noModifyPath?: boolean;
  expectedSha256?: string;
  observedTombstone?: string;
  env?: NodeJS.ProcessEnv;
  afterPublish?: (path: string, index: number) => void;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function assertSafePath(path: string): void {
  assertNoSymlinkPathComponents(dirname(path), path);
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`Refusing symlinked install path: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function ensureInstallDirectory(path: string): void {
  assertNoSymlinkPathComponents(path, path);
  ensureTrustedDirectory(path);
  const mode = lstatSync(path).mode;
  if (process.platform !== "win32" && (mode & 0o022) !== 0)
    throw new Error(`Refusing group/world-writable install directory: ${path}`);
}
function observeMarker(path: string): string {
  assertSafePath(path);
  const marker = readTrustedTextFile(path, {
    allowMissing: true,
    followSymlinks: false,
  });
  return marker ? sha256(marker.bytes) : "missing";
}
function pathLine(directory: string, fish: boolean): string {
  const quoted =
    "'" +
    (fish ? directory.replaceAll("\\", "\\\\") : directory).replaceAll(
      "'",
      fish ? "\\'" : "'\"'\"'",
    ) +
    "'";
  return fish
    ? `set -gx PATH ${quoted} $PATH`
    : `export PATH=${quoted}:"$PATH"`;
}
function recoverProfile(
  path: string,
  assertOwned: () => void,
  epoch: string,
): void {
  const journal = path + ".lore-install-journal";
  recoverInstallTransaction(
    journal,
    assertOwned,
    (candidate) => {
      if (
        candidate !== path &&
        !(
          dirname(candidate) === dirname(path) &&
          candidate.startsWith(
            join(
              dirname(path),
              "." + path.slice(dirname(path).length + 1) + ".lore-install-",
            ),
          )
        )
      )
        throw new Error("Unexpected shell profile recovery path");
      assertSafePath(candidate);
    },
    epoch,
    "rollback",
  );
}
function configurePath(
  home: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  assertOwned: () => void,
  epoch: string,
): void {
  if ((env.PATH ?? "").split(delimiter).includes(directory)) return;
  const shell = (env.SHELL ?? "").split("/").pop();
  const configs =
    shell === "fish"
      ? [join(home, ".config/fish/config.fish")]
      : shell === "zsh"
        ? [join(home, ".zshrc")]
        : shell === "bash"
          ? [
              join(home, ".bashrc"),
              existsSync(join(home, ".bash_profile"))
                ? join(home, ".bash_profile")
                : join(home, ".profile"),
            ]
          : [join(home, ".profile")];
  for (const path of configs) {
    ensureInstallDirectory(dirname(path));
    assertSafePath(path);
    const journal = path + ".lore-install-journal";
    const existing = readTrustedTextFile(path, {
      allowMissing: true,
      followSymlinks: false,
    });
    const line = pathLine(directory, shell === "fish");
    if ((existing?.text ?? "").split("\n").includes(line)) continue;
    const file = stageInstallFile(
      path,
      (existing?.text ?? "") + `\n# Added by lore installer\n${line}\n`,
      existing ? Number(existing.identity.mode & 0o7777n) : 0o600,
      existing,
    );
    commitInstallTransaction(
      journal,
      [file],
      assertOwned,
      () => {
        if (!verifyInstallFiles([file]))
          throw new Error("Shell profile changed during installation");
      },
      undefined,
      epoch,
    );
  }
}
export async function installStandalone(
  options: InstallOptions,
): Promise<string> {
  const home = realpathSync(options.home ?? homedir());
  if (dirname(home) === home)
    throw new Error("Refusing installation with HOME at filesystem root");
  const env = options.env ?? process.env;
  const installOverride = options.installDir ?? env.LORE_INSTALL_DIR;
  const configOverride = options.configDir ?? env.LORE_CONFIG_DIR;
  const installDir = resolve(installOverride ?? join(home, ".local/bin"));
  const configDir = resolve(configOverride ?? join(home, ".lore"));
  const source = resolve(options.source);
  const executable = join(
    installDir,
    process.platform === "win32" ? "lore.exe" : "lore",
  );
  const receipt = join(home, ".lore/install-path");
  const channel = join(configDir, "channel");
  const marker = join(home, ".lore/uninstalled.json");
  const journal = join(home, ".lore/install-transaction.json");
  const pathInstallDir =
    options.pathInstallDir ??
    (process.platform === "win32"
      ? installDir
          .replaceAll("\\", "/")
          .replace(
            /^([A-Za-z]):/,
            (_, drive: string) => "/" + drive.toLowerCase(),
          )
      : installDir);
  if (!isAbsolute(installDir) || /[\n\r]/.test(pathInstallDir))
    throw new Error("Invalid installation directory");
  return withLifecycleLock(
    "hosted-install",
    (lock) => {
      const assertOwned = () => lock.assertOwned();
      const targets = [executable, receipt, channel, journal];
      const allowed = (path: string) => {
        if (
          !targets.some(
            (target) =>
              path === target ||
              (dirname(path) === dirname(target) &&
                path.startsWith(
                  join(
                    dirname(target),
                    "." +
                      target.slice(dirname(target).length + 1) +
                      ".lore-install-",
                  ),
                )),
          )
        )
          throw new Error(`Unexpected installation recovery target: ${path}`);
        assertSafePath(path);
      };
      for (const path of [executable, receipt, channel, journal]) allowed(path);
      if (
        options.observedTombstone !== undefined &&
        observeMarker(marker) !== options.observedTombstone
      )
        throw new Error(
          "Uninstall generation changed while downloading; retry the installer",
        );
      const token = currentUninstallTombstoneToken(lock);
      const epoch = observeMarker(marker);
      recoverInstallTransaction(journal, assertOwned, allowed, epoch);
      for (const dir of [installDir, configDir]) ensureInstallDirectory(dir);
      assertSafePath(source);
      const candidate = readTrustedTextFile(source, { followSymlinks: false });
      if (
        !candidate ||
        (options.expectedSha256 &&
          sha256(candidate.bytes) !== options.expectedSha256)
      )
        throw new Error("Verified installation candidate changed");
      const files: InstallFile[] = [];
      try {
        assertOwned();
        const binary = stageInstallFile(executable, candidate.bytes, 0o755);
        files.push(binary);
        files.push(
          stageInstallFile(
            receipt,
            formatStandaloneInstallReceipt({
              executable,
              pathInstallDir,
              executableIdentity: stagedInstallIdentity(binary),
            }),
            0o600,
          ),
        );
        assertOwned();
        files.push(stageInstallFile(channel, options.channel, 0o600));
      } catch (error) {
        discardInstallStages(files, assertOwned);
        throw error;
      }
      commitInstallTransaction(
        journal,
        files,
        assertOwned,
        () => {
          if (!verifyInstallFiles(files))
            throw new Error(
              "Installed executable, receipt, or channel changed before commit",
            );
          if (token)
            clearUninstallTombstoneForVerifiedInstall(lock, token, () =>
              verifyInstallFiles(files),
            );
        },
        options.afterPublish,
        epoch,
      );
      for (const profile of [
        ".profile",
        ".bashrc",
        ".bash_profile",
        ".zshrc",
        ".config/fish/config.fish",
      ]) {
        try {
          recoverProfile(
            join(home, profile),
            assertOwned,
            files[1].after.sha256,
          );
        } catch (error) {
          console.error(
            `[lore] Profile recovery needs attention: ${String(error)}`,
          );
        }
      }
      if (!options.noModifyPath) {
        try {
          configurePath(
            home,
            pathInstallDir,
            env,
            assertOwned,
            files[1].after.sha256,
          );
        } catch (error) {
          console.error(
            `[lore] Installed successfully; PATH setup needs attention: ${String(error)}`,
          );
        }
      }
      return executable;
    },
    { lockPath: join(home, ".lore/lifecycle.lock"), timeoutMs: 0 },
  );
}
export async function commandInstall(args: string[]): Promise<void> {
  if (!isSea())
    throw new Error(
      "Binary installation requires a standalone Lore executable",
    );
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      install: { type: "boolean" },
      channel: { type: "string" },
      "source-sha256": { type: "string" },
      "observed-tombstone": { type: "string" },
      "path-install-dir": { type: "string" },
      "no-modify-path": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: lore setup --install --channel stable|nightly [--no-modify-path]",
    );
    return;
  }
  if (
    positionals.length ||
    !values.install ||
    !["stable", "nightly"].includes(values.channel ?? "") ||
    !/^[a-f0-9]{64}$/.test(values["source-sha256"] ?? "")
  )
    throw new Error("Invalid verified installation arguments");
  const path = await installStandalone({
    source: process.execPath,
    channel: values.channel as "stable" | "nightly",
    expectedSha256: values["source-sha256"],
    observedTombstone: values["observed-tombstone"],
    pathInstallDir: values["path-install-dir"],
    noModifyPath: values["no-modify-path"],
  });
  console.log(`Lore installed to ${path}`);
}
