/** `lore uninstall` — reverse persistent setup and remove the standalone CLI. */
import { buildCommand } from "../lib/command";
import { commandUninstall } from "../uninstall";

type UninstallFlags = {
  purge: boolean;
  yes: boolean;
  "dry-run": boolean;
};

export const uninstallCommand = buildCommand<UninstallFlags, []>({
  brief: "Undo persistent setup and remove the standalone Lore CLI",
  fullDescription:
    "Restores setup-managed configuration and removes standalone install " +
    "artifacts. Local data and project files are preserved unless --purge " +
    "is explicitly confirmed. Package-managed CLIs must still be removed " +
    "with their package manager.",
  parameters: {
    aliases: { y: "yes" },
    flags: {
      purge: {
        kind: "boolean",
        brief:
          "Also delete default local data, logs, credentials, and runtime state",
        default: false,
      },
      yes: {
        kind: "boolean",
        brief: "Skip the --purge confirmation prompt (alias: -y)",
        default: false,
      },
      "dry-run": {
        kind: "boolean",
        brief: "Show the cleanup plan without changing anything",
        default: false,
      },
    },
  },
  async handler(flags) {
    await commandUninstall([], {
      purge: flags.purge,
      yes: flags.yes,
      "dry-run": flags["dry-run"],
    });
  },
});
