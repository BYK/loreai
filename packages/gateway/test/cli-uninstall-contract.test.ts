import { afterEach, describe, expect, test, vi } from "vitest";

const commandUninstall = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../src/cli/uninstall", () => ({ commandUninstall }));

import { LEGACY_ROUTES } from "../src/cli/app";
import { runCli } from "../src/cli/cli";
import { KNOWN_ROOT_COMMANDS, STRICLI_ROUTES } from "../src/cli/lib/argv";

describe("lore uninstall CLI contract", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    commandUninstall.mockClear();
  });

  test("is registered as a typed root command", () => {
    expect(STRICLI_ROUTES.has("uninstall")).toBe(true);
    expect(KNOWN_ROOT_COMMANDS.has("uninstall")).toBe(true);
    expect(LEGACY_ROUTES.has("uninstall")).toBe(false);
  });

  test("forwards the destructive flags explicitly", async () => {
    process.argv = [
      "node",
      "lore",
      "uninstall",
      "--purge",
      "--yes",
      "--dry-run",
    ];

    await runCli();

    expect(commandUninstall).toHaveBeenCalledWith([], {
      purge: true,
      yes: true,
      "dry-run": true,
    });
  });

  test("defaults to data-preserving behavior", async () => {
    process.argv = ["node", "lore", "uninstall"];

    await runCli();

    expect(commandUninstall).toHaveBeenCalledWith([], {
      purge: false,
      yes: false,
      "dry-run": false,
    });
  });
});
