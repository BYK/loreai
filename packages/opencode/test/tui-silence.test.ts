import { afterEach, describe, expect, test } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import { log } from "@loreai/core";
import { LorePlugin } from "../src/index";

/**
 * The OpenCode plugin runs inside OpenCode's full-screen TUI, where any byte on
 * stdout/stderr corrupts the render. On activation it must flip
 * `log.silenceStderr()` so neither the plugin nor the in-process gateway it
 * hosts can ever write `[lore]` to the terminal.
 *
 * `LORE_DISABLED=1` keeps activation from probing/starting a real gateway while
 * still exercising the (pre-gateway) silence switch. The global test setup
 * resets the flag after each test.
 */
describe("opencode plugin — TUI stderr silencing on activation", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    log.silenceStderr(false);
  });

  test("activating the plugin silences stderr so [lore] can't reach the TUI", async () => {
    for (const k of ["LORE_OPENCODE_FORCE_ACTIVE", "LORE_DISABLED"]) {
      saved[k] = process.env[k];
    }
    log.silenceStderr(false);
    expect(log.isStderrSilenced()).toBe(false);

    process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
    process.env.LORE_DISABLED = "1";

    await LorePlugin({
      client: {
        tui: { showToast: () => Promise.resolve() },
      } as unknown as PluginInput["client"],
      project: { id: "tui-silence" } as unknown as PluginInput["project"],
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://localhost:0"),
      $: {} as unknown as PluginInput["$"],
    });

    expect(log.isStderrSilenced()).toBe(true);
  });
});
