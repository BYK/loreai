import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "@loreai/core";
import lorePiExtension from "../src/index";

/**
 * The Pi extension runs inside Pi's full-screen TUI, where any byte on
 * stdout/stderr corrupts the render (the bug Daniel hit on Windows). On
 * activation it must flip `log.silenceStderr()` so neither the extension nor
 * the in-process gateway it hosts can ever write `[lore]` to the terminal.
 *
 * `LORE_DISABLED=1` returns the extension inert right after the silence switch,
 * so no gateway is probed/started. The global test setup resets the flag.
 */
describe("pi extension — TUI stderr silencing on activation", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    log.silenceStderr(false);
  });

  test("activating the extension silences stderr so [lore] can't reach the TUI", async () => {
    for (const k of ["LORE_PI_FORCE_ACTIVE", "LORE_DISABLED"]) {
      saved[k] = process.env[k];
    }
    log.silenceStderr(false);
    expect(log.isStderrSilenced()).toBe(false);

    process.env.LORE_PI_FORCE_ACTIVE = "1";
    process.env.LORE_DISABLED = "1";

    const mockPi = {
      registerProvider: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;
    await lorePiExtension(mockPi);

    expect(log.isStderrSilenced()).toBe(true);
  });
});
