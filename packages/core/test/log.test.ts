import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Import a fresh copy of the log module with a controlled `LORE_DEBUG` value.
 *
 * `isDebug` (and the `stderrSilenced` flag) are module-level state captured at
 * import time, so each test resets the module registry to get a clean,
 * deterministic instance regardless of the ambient environment.
 */
async function freshLog(debug: string | undefined) {
  if (debug === undefined) delete process.env.LORE_DEBUG;
  else process.env.LORE_DEBUG = debug;
  vi.resetModules();
  return import("../src/log");
}

function makeSink() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
  };
}

describe("log stderr silencing (embedded/TUI mode)", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  const savedDebug = process.env.LORE_DEBUG;

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    if (savedDebug === undefined) delete process.env.LORE_DEBUG;
    else process.env.LORE_DEBUG = savedDebug;
    vi.resetModules();
  });

  it("writes errors and notices to stderr by default", async () => {
    const log = await freshLog(undefined);
    expect(log.isStderrSilenced()).toBe(false);

    log.error("boom");
    log.notice("heads up");

    expect(stderr).toHaveBeenCalledWith("[lore]", "boom");
    expect(stderr).toHaveBeenCalledWith("[lore]", "heads up");
  });

  it("silenceStderr() suppresses stderr for EVERY level, even with LORE_DEBUG=1", async () => {
    // LORE_DEBUG=1 would normally let info/warn through too — silencing wins.
    const log = await freshLog("1");
    log.silenceStderr();
    expect(log.isStderrSilenced()).toBe(true);

    log.info("i");
    log.warn("w");
    log.notice("n");
    log.error("e");

    expect(stderr).not.toHaveBeenCalled();
  });

  it("keeps forwarding to the file/sink while stderr is silenced", async () => {
    const log = await freshLog("1");
    const sink = makeSink();
    log.registerSink(sink);
    log.silenceStderr();

    log.info("i");
    log.warn("w");
    log.notice("n");
    log.error("e");

    // Nothing reached the TUI...
    expect(stderr).not.toHaveBeenCalled();
    // ...but the sink (Sentry/file bridge) still received everything.
    expect(sink.info).toHaveBeenCalledWith("i");
    expect(sink.warn).toHaveBeenCalledWith("w");
    expect(sink.warn).toHaveBeenCalledWith("n"); // notice -> warn severity
    expect(sink.error).toHaveBeenCalledWith("e");
  });

  it("notice is NOT debug-gated (visible on a standalone CLI), unlike warn", async () => {
    const log = await freshLog(undefined); // LORE_DEBUG unset -> isDebug false
    expect(log.isStderrSilenced()).toBe(false);

    log.warn("should-be-hidden");
    log.notice("should-be-visible");

    // warn is suppressed without debug; notice is always visible.
    expect(stderr).not.toHaveBeenCalledWith("[lore] WARN:", "should-be-hidden");
    expect(stderr).toHaveBeenCalledWith("[lore]", "should-be-visible");
  });

  it("notice reports to the sink at WARNING severity, not error", async () => {
    const log = await freshLog(undefined);
    const sink = makeSink();
    log.registerSink(sink);

    log.notice("misattribution warning");

    expect(sink.warn).toHaveBeenCalledWith("misattribution warning");
    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.captureException).not.toHaveBeenCalled();
  });

  it("shares the silence flag across SEPARATE core module instances (bundled-gateway safety)", async () => {
    // The in-process gateway can be a second, independently-bundled copy of
    // @loreai/core (its Node/CJS bundle inlines core). The plugin silences via
    // its own copy; the gateway logs via its bundled copy. A module-level flag
    // would not cross that boundary — so the flag must be process-global.
    const first = await freshLog(undefined);
    first.silenceStderr(true);

    // A genuinely different module instance (as the gateway's bundled core is
    // at runtime) must observe the flag set by the first instance.
    vi.resetModules();
    const second = await import("../src/log");
    expect(second).not.toBe(first);
    expect(second.isStderrSilenced()).toBe(true);

    // ...and clearing it from the second instance is seen by the first.
    second.silenceStderr(false);
    expect(first.isStderrSilenced()).toBe(false);
  });

  it("silenceStderr(false) restores stderr visibility", async () => {
    const log = await freshLog(undefined);
    log.silenceStderr(true);
    expect(log.isStderrSilenced()).toBe(true);
    log.silenceStderr(false);
    expect(log.isStderrSilenced()).toBe(false);

    log.error("now visible");
    expect(stderr).toHaveBeenCalledWith("[lore]", "now visible");
  });
});
