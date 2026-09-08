import { dirname, posix, resolve, win32 } from "node:path";
import type { ExecutableIdentity } from "./uninstall";

export function formatStandaloneInstallReceipt(input: {
  executable: string;
  pathInstallDir: string;
  executableIdentity: ExecutableIdentity;
  platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  if (
    !pathApi.isAbsolute(input.executable) ||
    !posix.isAbsolute(input.pathInstallDir) ||
    input.executable.includes("\n") ||
    input.executable.includes("\r") ||
    input.pathInstallDir.includes("\n") ||
    input.pathInstallDir.includes("\r") ||
    !/^[a-f0-9]{64}$/.test(input.executableIdentity.sha256) ||
    input.executableIdentity.device < 0n ||
    input.executableIdentity.inode < 0n ||
    input.executableIdentity.size < 0n ||
    input.executableIdentity.mtimeNs < 0n ||
    input.executableIdentity.device === 0n ||
    input.executableIdentity.inode === 0n ||
    (platform !== "win32" &&
      resolve(input.pathInstallDir) !== dirname(resolve(input.executable)))
  ) {
    throw new Error("Refusing invalid standalone install receipt fields");
  }
  return [
    "lore-install-receipt-v3",
    `executable=${input.executable}`,
    `path-install-dir=${input.pathInstallDir}`,
    `sha256=${input.executableIdentity.sha256}`,
    `device=${input.executableIdentity.device}`,
    `inode=${input.executableIdentity.inode}`,
    `size=${input.executableIdentity.size}`,
    `mtime-ns=${input.executableIdentity.mtimeNs}`,
    "",
  ].join("\n");
}
