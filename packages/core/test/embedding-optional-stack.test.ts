import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import {
  embed,
  isAvailable,
  runStartupBackfill,
  LocalProviderUnavailableError,
  _markLocalProviderUnavailable,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
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
    registerSink(passthroughSink);
    _setTestWorkerFactory(null);
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

  it("genuine init failure → ERROR 'failed to init', latches FTS-only", async () => {
    const fakes: FakeWorker[] = [];
    _setTestWorkerFactory(() => {
      const f = new FakeWorker();
      fakes.push(f);
      return f as unknown as Worker;
    });

    const result = settle(embed(["hello"], "query"));
    await flush();

    fakes[0].emit("message", {
      type: "init-error",
      error: "model load failed: corrupt tokenizer.json",
    });
    await flush();

    const r = await result;
    expect(r.ok).toBe(false);
    expect(isAvailable()).toBe(false);

    const errors = logs.filter((l) => l.level === "error");
    const warns = logs.filter((l) => l.level === "warn");
    expect(errors.some((l) => /failed to init/i.test(l.message))).toBe(true);
    // The install-guidance warn is reserved for the not-installed case.
    expect(warns.some((l) => /not installed/i.test(l.message))).toBe(false);
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
});
