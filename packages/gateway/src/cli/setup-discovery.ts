import { lstatSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { trustedFileExists } from "./json-config";

type CodexSetupEvidence = { kind: "config" | "desktop app"; path: string };

function hasKind(path: string, kind: "file" | "directory"): boolean {
  try {
    const stat = lstatSync(path);
    return kind === "file" ? stat.isFile() : stat.isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** Setup can configure desktop clients even when there is no launchable CLI. */
export function findCodexSetupEvidence(
  configPath: string,
  reportProbeError?: (appPath: string, error: unknown) => void,
): CodexSetupEvidence | null {
  if (trustedFileExists(configPath))
    return { kind: "config", path: configPath };
  if (platform() !== "darwin") return null;

  for (const directory of [join(homedir(), "Applications"), "/Applications"]) {
    for (const [name, marker] of [
      ["Codex.app", "Contents"],
      ["ChatGPT.app", "Contents/Resources/codex-cli"],
    ] as const) {
      const path = join(directory, name);
      try {
        if (
          hasKind(join(path, marker), "directory") &&
          hasKind(join(path, "Contents", "Info.plist"), "file")
        ) {
          return { kind: "desktop app", path };
        }
      } catch (error) {
        // Optional installation hints must not block other candidates or agents.
        // Config trust failures propagate so the caller can skip this target.
        reportProbeError?.(path, error);
      }
    }
  }
  return null;
}
