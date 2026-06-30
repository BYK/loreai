import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@loreai/core";
import { parseCurlHeaders } from "../src/config";

/**
 * When the gateway runs *in-process* inside a host that owns a full-screen TUI
 * (the Pi extension, the OpenCode plugin), the host flips `log.silenceStderr()`
 * once on activation. From then on NOTHING the gateway logs — not warnings, not
 * errors — may reach the terminal, or it corrupts the TUI (the class of bug
 * that broke Pi on Windows).
 *
 * These tests exercise a *real* migrated gateway log site (`parseCurlHeaders`
 * in config.ts emits a `[lore]` warning on a malformed header line) to prove:
 *   1. the site routes through `@loreai/core`'s `log`, not raw `console.*`;
 *   2. `silenceStderr()` called via the `@loreai/core` barrel reaches code in
 *      the *gateway* package. (Under vitest both resolve to the same `core`
 *      source module. In PRODUCTION the bundled gateway inlines its OWN copy of
 *      `core`, so the flag instead bridges the two copies via a process-global
 *      on `globalThis` — that separate bundled-boundary case is covered by
 *      core/test/log.test.ts's cross-instance test, not this one.)
 */
describe("in-process gateway TUI safety", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  const MALFORMED = "this-header-line-has-no-colon";

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    // Never leak silenced state into other files sharing this worker.
    log.silenceStderr(false);
  });

  it("emits a [lore] warning to stderr by default (the leak we are guarding)", () => {
    log.silenceStderr(false);

    parseCurlHeaders(MALFORMED);

    const wroteLore = stderr.mock.calls.some((args: unknown[]) =>
      args.join(" ").includes("[lore]"),
    );
    expect(wroteLore).toBe(true);
  });

  it("silenceStderr() via @loreai/core suppresses the gateway's own [lore] writes", () => {
    log.silenceStderr(true);

    parseCurlHeaders(MALFORMED);

    expect(stderr).not.toHaveBeenCalled();
  });
});
