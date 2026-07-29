/**
 * Safe process exit for the gateway binary.
 *
 * The gateway embeds an embedding worker thread that loads native ORT
 * (`onnxruntime-node` / `@loreai/onnxruntime-<target>/onnxruntime_binding.node`).
 * On the **forced** shutdown path — the 4000ms `SHUTDOWN_DEADLINE_MS` cap fires
 * while the worker is still mid-inference — a normal `process.exit()` walks the
 * atexit chain and NAPI env destructors with the worker's native call still in
 * flight. The addon then throws an uncatchable `Napi::Error` →
 * `libc++abi: terminating` → SIGABRT (the "💣 Program crashed" report).
 *
 * To avoid that, both helpers below bypass C++/libuv teardown:
 *   - `safeExit()`: the NORMAL exit path. Tries libc `_exit` via FFI under Bun
 *     (where the bug was first seen) — that runtime's `bun:ffi` lets us call
 *     `_exit` directly. Under Node, falls back to `process.exit()` because
 *     Node handles NAPI teardown correctly *when the worker has already exited*
 *     (which is the common case here — the worker self-exits via a deferred
 *     `process.exit(0)` in `embedding-worker.ts:808` before this is called).
 *   - `forcedExit()`: the FORCED path (deadline timeout, second signal, child
 *     error). Always skips teardown — under Bun via `_exit` FFI, under Node via
 *     `process.kill(process.pid, 'SIGKILL')` (the only portable Node mechanism
 *     that matches `_exit` semantics; `process.reallyExit` still runs C++/libuv
 *     teardown and would crash the same way).
 *
 * `_exit` / SIGKILL skip: atexit handlers, stdio flushing, NAPI destructor hooks.
 * This is safe for the gateway because:
 *   - SQLite WAL mode handles incomplete writes (journal recovery on next boot)
 *   - The embedding worker is unref'd and any pending work is re-indexed by
 *     `runStartupBackfill` on next boot
 *   - stderr output was already flushed before shutdown() resolved
 *
 * Trade-off: forced exits return 137 (128 + SIGKILL(9)) instead of the
 * signal-correct `signalExitCode(signal)`. Acceptable — a clean exit code was
 * never going to happen on the forced path, and the crash-report noise is worse
 * than 137.
 */

type BunGlobal = { Bun?: unknown };

function ffiExit(code: number): boolean {
  if (typeof (globalThis as BunGlobal).Bun === "undefined") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const libs =
      process.platform === "win32"
        ? ["msvcrt.dll"]
        : process.platform === "darwin"
          ? ["libSystem.B.dylib"]
          : ["libc.so.6"];
    for (const name of libs) {
      try {
        dlopen(name, {
          _exit: { args: [FFIType.int], returns: FFIType.void },
        }).symbols._exit(code);
        return true;
      } catch {
        /* try next lib */
      }
    }
  } catch {
    /* bun:ffi not available */
  }
  return false;
}

/**
 * Exit the process normally. Skips teardown only under Bun (where the NAPI
 * teardown bug was first reported and lives); under Node, defers to
 * `process.exit()`. Use this for clean shutdowns — the worker has already
 * exited by the time this is called.
 */
export function safeExit(code: number): never {
  if (ffiExit(code)) {
    // ffiExit returns true after actually invoking `_exit` via FFI, which
    // terminates the process immediately. The function is `never`-typed, but
    // this `return` is a defensive guard for non-Bun runtimes where a
    // mocked/partial ffiExit could fall through.
    return undefined as never;
  }
  process.exit(code);
}

/**
 * Exit the process forcibly, skipping all C++/libuv/NAPI teardown. Use this on
 * the deadline-bounded shutdown paths (timeout, second signal, child error)
 * where the embedding worker may still be mid-inference in a native call that
 * `worker.terminate()` could not interrupt.
 *
 * Exit code becomes 137 under Node (`SIGKILL`), which shells render as "Killed".
 *
 * The `code` parameter is intentionally unused on the Node path — SIGKILL is
 * unconditional; the clean exit code was never going to reach the shell on a
 * forced exit anyway. It is preserved for API symmetry with `safeExit` and so
 * future runtimes with a teardown-free exit can honor it.
 */
export function forcedExit(code: number): never {
  // Set the exit code BEFORE we terminate — shells that render SIGKILL as
  // "Killed" still expose the suggested exit code (`echo $?` after a foreground
  // SIGKILL returns the suggested code on most shells; the kernel honors it
  // for waitpid-style reporting). This is the only way to surface `code` since
  // SIGKILL doesn't carry it.
  process.exitCode = code;
  if (!ffiExit(code)) {
    // SIGKILL skips all atexit / NAPI teardown. Observed asynchronously.
    process.kill(process.pid, "SIGKILL");
  }
  // Neither branch returns control to the caller in production. We deliberately
  // do NOT throw — the throw would race SIGKILL (which is asynchronous) and
  // produce an unhandled promise rejection / uncaught exception in signal
  // handlers (see Sentry review on PR #1520). The `never` return type is
  // satisfied by entering an unreachable tight loop: the kernel delivers SIGKILL
  // before any further statement executes.
  //
  // Test sentinel: when LORE_FORCED_EXIT_SENTINEL=1 is set (exit.test.ts sets
  // it in beforeEach and clears it in afterEach), throw a tagged error so tests
  // can observe "would exit here" without the tight loop hanging the worker.
  // Production never sets this.
  if (process.env.LORE_FORCED_EXIT_SENTINEL === "1") {
    throw new Error(`__forcedExit__:${code}`);
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    /* unreachable: SIGKILL is enqueued and will fire before this loop yields */
  }
}
