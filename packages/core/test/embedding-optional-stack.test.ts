import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  computeInitRetryDelayMs,
  embed,
  isAvailable,
  runStartupBackfill,
  LocalProviderUnavailableError,
  _getLocalInitRetryAtForTest,
  _markLocalProviderUnavailable,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setLocalInitCooldownMsForTest,
  _setTestWorkerFactory,
} from "../src/embedding";
import { isMissingLocalStackError } from "../src/embedding-worker-types";
import { type LogSink, registerSink } from "../src/log";

// #1026: `@huggingface/transformers` (+ its native transitive deps
// onnxruntime-node/onnxruntime-web/sharp) is an OPTIONAL dependency of
// @loreai/core. A consumer on remote embeddings — or the SEA binary, which
// ships its own runtime — can `--omit=optional` and drop ~480 MB. When the
// stack is absent the local provider must degrade to FTS-only recall, and the
// degraded state must be VISIBLE and correctly classified (an expected "not
// installed" warn, not an alarming "failed to init" error).

// ---------------------------------------------------------------------------
// Part A — isMissingLocalStackError classifier (pure)
// ---------------------------------------------------------------------------

describe("isMissingLocalStackError", () => {
  test("true: ESM import of the absent optional package", () => {
    expect(
      isMissingLocalStackError(
        "Cannot find package '@huggingface/transformers' imported from /app/worker.cjs",
      ),
    ).toBe(true);
    expect(
      isMissingLocalStackError(
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@huggingface/transformers'",
      ),
    ).toBe(true);
  });

  test("true: the native transitive deps are absent (--omit=optional)", () => {
    // transformers is bundled into the worker, so with optionals omitted the
    // failure surfaces from its transitive require("onnxruntime-node").
    expect(
      isMissingLocalStackError("Cannot find module 'onnxruntime-node'"),
    ).toBe(true);
    expect(
      isMissingLocalStackError(
        "Could not locate the bindings file for onnxruntime-node",
      ),
    ).toBe(true);
    expect(isMissingLocalStackError("Cannot find module 'sharp'")).toBe(true);
  });

  test("false: module-not-found WITHOUT a known optional package (e.g. a model file)", () => {
    // A missing model file must NOT be misread as "stack not installed".
    expect(
      isMissingLocalStackError(
        "Cannot find module '/home/u/.cache/lore/model/model_quantized.onnx'",
      ),
    ).toBe(false);
  });

  test("false: a runtime failure that merely mentions onnxruntime (not a resolution error)", () => {
    // OOM / allocation failures name onnxruntime but are NOT not-installed.
    expect(
      isMissingLocalStackError("onnxruntime allocation failed: 284792864"),
    ).toBe(false);
    expect(isMissingLocalStackError("pipeline is not a function")).toBe(false);
    expect(isMissingLocalStackError("Aborted(). Build with -sASSERTIONS")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Part B — init-error classification: "not installed" (warn) vs genuine
//          init failure (error). Both latch the provider broken.
// ---------------------------------------------------------------------------

/** Minimal stand-in for a node:worker_threads Worker (mirrors the seam used by
 *  embedding-oom-recovery.test.ts) so we can emit "message" deterministically. */
class FakeWorker extends EventEmitter {
  postMessage(): void {}
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface Captured {
  level: "info" | "warn" | "error";
  message: string;
}

function capturingSink(out: Captured[]): LogSink {
  return {
    info: (m) => out.push({ level: "info", message: m }),
    warn: (m) => out.push({ level: "warn", message: m }),
    error: (m) => out.push({ level: "error", message: m }),
    captureException: () => {},
  };
}

const passthroughSink: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

/** Attach handlers immediately so the LocalProviderUnavailableError rejection
 *  that fires while we drive the worker is never flagged "unhandled". */
function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, err }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("init-error classification (worker-mock)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;
  let logs: Captured[];

  beforeEach(() => {
    // Force the local provider (no remote fallback) and a fresh instance.
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
    logs = [];
    registerSink(capturingSink(logs));
  });

  afterEach(() => {
    vi.useRealTimers();
    registerSink(passthroughSink);
    _setTestWorkerFactory(null);
    _setLocalInitCooldownMsForTest(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
  });

  it("missing optional stack → WARN 'not installed', latches FTS-only (no error)", async () => {
    const fakes: FakeWorker[] = [];
    _setTestWorkerFactory(() => {
      const f = new FakeWorker();
      fakes.push(f);
      return f as unknown as Worker;
    });

    const result = settle(embed(["hello"], "query"));
    await flush();
    expect(fakes).toHaveLength(1);

    // The worker (or its bundled transformers) can't resolve the optional stack.
    fakes[0].emit("message", {
      type: "init-error",
      error: "Cannot find module 'onnxruntime-node'",
    });
    await flush();

    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toBeInstanceOf(LocalProviderUnavailableError);
    expect(isAvailable()).toBe(false); // degraded to FTS-only

    const warns = logs.filter((l) => l.level === "warn");
    const errors = logs.filter((l) => l.level === "error");
    expect(warns.some((l) => /not installed/i.test(l.message))).toBe(true);
    // A deliberately-omitted optional dep must NOT be logged at error severity.
    expect(errors).toHaveLength(0);
  });

  it("genuine init failures retry, then ERROR 'failed to init' + latch after the budget", async () => {
    _setLocalInitCooldownMsForTest(0); // drive the retries without waiting
    const fakes: FakeWorker[] = [];
    _setTestWorkerFactory(() => {
      const f = new FakeWorker();
      fakes.push(f);
      return f as unknown as Worker;
    });

    // A genuine (non-missing-stack) init failure is now RETRIED with a fresh
    // worker rather than latching on the first failure — only after the retry
    // budget (3 attempts) is exhausted does it error + degrade permanently.
    const GENUINE = "model load failed: corrupt tokenizer.json";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = settle(embed(["hello"], "query"));
      await flush();
      const worker = fakes.at(-1);
      if (!worker) throw new Error("no worker spawned");
      worker.emit("message", { type: "init-error", error: GENUINE });
      await flush();
      const r = await result;
      expect(r.ok).toBe(false);
      if (attempt < 3) expect(isAvailable()).toBe(true); // still retryable
    }

    expect(isAvailable()).toBe(false); // budget exhausted → permanently FTS-only

    const errors = logs.filter((l) => l.level === "error");
    const warns = logs.filter((l) => l.level === "warn");
    // Intermediate attempts warn (retry, not the benign not-installed message);
    // the terminal failure errors.
    expect(warns.some((l) => /init failed \(attempt/i.test(l.message))).toBe(
      true,
    );
    expect(errors.some((l) => /failed to init/i.test(l.message))).toBe(true);
    // The install-guidance warn is reserved for the not-installed case.
    expect(warns.some((l) => /not installed/i.test(l.message))).toBe(false);
  });

  it("transient init failure arms a FAST first retry (2s), not the 30s ceiling", async () => {
    _setLocalInitCooldownMsForTest(null); // production ceiling (30s)
    // Freeze Date ONLY (keep real timers so flush()'s setTimeout still fires) so
    // the armed deadline is deterministic — no wall-clock/monotonicity guessing.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const fakes: FakeWorker[] = [];
    _setTestWorkerFactory(() => {
      const f = new FakeWorker();
      fakes.push(f);
      return f as unknown as Worker;
    });

    const result = settle(embed(["hello"], "query"));
    await flush();
    // A cold ORT parse failure — transient, recovers on the next fresh worker.
    fakes[0].emit("message", {
      type: "init-error",
      error: "Can't create a session. ERROR_CODE: 7, protobuf parsing failed",
    });
    await flush();
    await result;

    // Date frozen at 0 → the deadline IS the backoff delay: exactly 2s
    // (INIT_RETRY_BASE_MS), NOT the flat 30s the provider used to wait — that
    // flat wait was the entire startup FTS-only window for a self-healing blip.
    // Fails if reverted to the fixed-cooldown behaviour (would be 30_000).
    expect(_getLocalInitRetryAtForTest()).toBe(2_000);
    expect(isAvailable()).toBe(false); // FTS-only during the (now short) cooldown
  });
});

// ---------------------------------------------------------------------------
// Part B2 — init-retry backoff schedule (pure)
// ---------------------------------------------------------------------------

describe("computeInitRetryDelayMs (init-retry backoff)", () => {
  test("fast first retry, geometric backoff, clamped to the ceiling", () => {
    // Production ceiling 30s; LOCAL_INIT_MAX_ATTEMPTS=3 → two retry waits: 2s, 8s.
    expect(computeInitRetryDelayMs(1, 30_000)).toBe(2_000);
    expect(computeInitRetryDelayMs(2, 30_000)).toBe(8_000);
    // 32s (attempt 3) would exceed the ceiling → clamped.
    expect(computeInitRetryDelayMs(3, 30_000)).toBe(30_000);
    // A lower ceiling clamps sooner.
    expect(computeInitRetryDelayMs(2, 5_000)).toBe(5_000);
  });

  test("ceiling 0 (the test seam) collapses to immediate retry", () => {
    expect(computeInitRetryDelayMs(1, 0)).toBe(0);
    expect(computeInitRetryDelayMs(2, 0)).toBe(0);
  });

  test("guards failures < 1 (never a negative exponent)", () => {
    expect(computeInitRetryDelayMs(0, 30_000)).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// Part C — runStartupBackfill makes the degraded state visible
// ---------------------------------------------------------------------------

describe("runStartupBackfill degraded-state log", () => {
  let savedProvider: unknown;
  let logs: Captured[];

  beforeEach(() => {
    savedProvider = _saveAndClearProvider();
    logs = [];
    registerSink(capturingSink(logs));
  });

  afterEach(() => {
    registerSink(passthroughSink);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
  });

  it("logs that backfill was skipped when embeddings are unavailable", async () => {
    _markLocalProviderUnavailable();
    const stats = await runStartupBackfill();
    expect(stats.knowledgeEmbedded).toBe(0);
    expect(
      logs.some(
        (l) => l.level === "info" && /backfill skipped/i.test(l.message),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part D — packaging invariant: the local stack is an OPTIONAL dependency
// ---------------------------------------------------------------------------

describe("packaging: @huggingface/transformers is optional (#1026)", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), {
      encoding: "utf8",
    }),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  test("declared under optionalDependencies, not dependencies", () => {
    expect(
      pkg.optionalDependencies?.["@huggingface/transformers"],
    ).toBeTruthy();
    expect(pkg.dependencies?.["@huggingface/transformers"]).toBeUndefined();
  });

  // #1220: the native ONNX backend (onnxruntime-node) + image codec (sharp) are
  // deps of @huggingface/transformers, but the worker in packages/core/dist/**
  // must resolve them at runtime. As transitive-only deps they nest under
  // .pnpm/@huggingface+transformers/… in a strict-pnpm layout and are
  // unreachable from dist/ — transformers init throws and recall silently
  // degrades to FTS-only. Declaring them directly (still optional) links them
  // adjacent to core so the worker resolves them, without affecting the gateway
  // bundle (which inlines core and externalizes onnxruntime-node) or a
  // --omit=optional install. Pins must track @huggingface/transformers' own
  // onnxruntime-node/sharp versions so pnpm dedupes to a single instance.
  test("onnxruntime-node and sharp are declared optional too (#1220)", () => {
    for (const dep of ["onnxruntime-node", "sharp"]) {
      expect(pkg.optionalDependencies?.[dep]).toBeTruthy();
      expect(pkg.dependencies?.[dep]).toBeUndefined();
    }
  });

  // The resolution invariant the bug violated: the built worker resolves the
  // native backend from @loreai/core's OWN node_modules at runtime. This MUST
  // run in a real Node subprocess based at the dist worker's path — NOT an
  // in-process createRequire — because vitest's Vite resolver walks the .pnpm
  // store directly and passes even with the fix fully reverted (a vacuous test,
  // caught in the PR #1223 adversarial review). We also SCRUB NODE_PATH: pnpm
  // points it at .pnpm/node_modules, and an inherited NODE_PATH would let the
  // subprocess resolve the dep from the virtual store regardless of the fix
  // (a published/plugin consumer has no such NODE_PATH). The worker file itself
  // need not exist: Node resolves from its parent directory up through
  // node_modules. Skipped under --omit=optional / unsupported platforms.
  const stackInstalled = (() => {
    try {
      createRequire(import.meta.url).resolve("@huggingface/transformers");
      return true;
    } catch {
      return false;
    }
  })();
  const workerPath = fileURLToPath(
    new URL("../dist/node/embedding-worker.js", import.meta.url),
  );
  function resolvesInRealNode(dep: string): boolean {
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    try {
      execFileSync(
        process.execPath,
        [
          "-e",
          `require("module").createRequire(${JSON.stringify(workerPath)}).resolve(${JSON.stringify(dep)})`,
        ],
        { stdio: "pipe", env },
      );
      return true;
    } catch {
      return false;
    }
  }
  test.runIf(stackInstalled)(
    "native backend resolves from @loreai/core's dist worker in a real Node process (#1220)",
    () => {
      expect(resolvesInRealNode("onnxruntime-node")).toBe(true);
      expect(resolvesInRealNode("sharp")).toBe(true);
    },
  );
});
