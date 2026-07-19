import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  isOomError,
  isWasmFatalError,
  isCorruptModelError,
  isTransformersInferenceDumpLine,
  looksLikeIntactOnnxFile,
  MIN_ONNX_FILE_BYTES,
  resolveModelCacheDir,
  shouldHealCorruptModel,
  shouldPostPerRequestError,
  shouldRequestWasmRespawn,
  TRANSFORMERS_INFERENCE_DUMP_PREFIXES,
} from "../src/embedding-worker-types";

describe("isCorruptModelError", () => {
  test("matches the real truncated-download error observed in production", () => {
    // The exact message observed when a 137MB model only downloaded ~87MB.
    const msg =
      "Load model from /home/byk/.../onnx/model_quantized.onnx failed:Protobuf parsing failed.";
    expect(isCorruptModelError(msg)).toBe(true);
  });

  test.each([
    "Protobuf parsing failed.",
    "protobuf parsing failed",
    "Load model from foo.onnx failed: protobuf parsing error",
    "Failed to load model: deserialization error",
    "invalid model file",
    "corrupt model data",
    "corrupted model",
    "Error deserializing ModelProto",
    "deserialization error",
  ])("classifies corrupt-model message: %s", (msg) => {
    expect(isCorruptModelError(msg)).toBe(true);
  });

  test.each([
    "287180544", // ONNX OOM numeric code
    "out of memory",
    "Aborted(). Build with -sASSERTIONS",
    "RuntimeError: unreachable",
    "pipe is not a function",
    "network timeout",
    "ECONNRESET",
    "",
  ])("does NOT classify non-corruption message: %s", (msg) => {
    expect(isCorruptModelError(msg)).toBe(false);
  });

  // The critical false-positive class: transient download/auth/network failures
  // must NOT be treated as on-disk corruption, or the worker would loop
  // purge→redownload→fail forever. These are the real transformers.js / HF Hub
  // download-failure strings.
  test.each([
    'Unauthorized access to file: "https://huggingface.co/..."',
    'Could not locate file: "https://huggingface.co/.../model_quantized.onnx"',
    "401 Unauthorized: failed to load model download",
    "Failed to load model: 403 Forbidden",
    "Could not load model nomic-ai/x: network request failed",
    'Error (500) occurred while trying to load file: "..."',
    "fetch failed",
    "ETIMEDOUT while downloading model",
    "ENOTFOUND huggingface.co",
  ])("does NOT misclassify transient download failure: %s", (msg) => {
    expect(isCorruptModelError(msg)).toBe(false);
  });

  test("is disjoint from OOM classification for OOM codes", () => {
    // An OOM numeric code must not be treated as a corrupt model (it would
    // trigger a pointless re-download instead of the correct fatal handling).
    const oom = "287180544";
    expect(isOomError(oom)).toBe(true);
    expect(isWasmFatalError(oom)).toBe(true);
    expect(isCorruptModelError(oom)).toBe(false);
  });
});

describe("resolveModelCacheDir", () => {
  test("resolves <cacheDir>/<modelId segments>", () => {
    expect(
      resolveModelCacheDir("/cache", "nomic-ai/nomic-embed-text-v1.5"),
    ).toBe("/cache/nomic-ai/nomic-embed-text-v1.5");
  });

  test("strips trailing slashes from cacheDir", () => {
    expect(resolveModelCacheDir("/cache/", "org/model")).toBe(
      "/cache/org/model",
    );
    expect(resolveModelCacheDir("/cache//", "org/model")).toBe(
      "/cache/org/model",
    );
  });

  test("handles a single-segment model id", () => {
    expect(resolveModelCacheDir("/cache", "model")).toBe("/cache/model");
  });

  test.each([
    [null, "org/model"],
    [undefined, "org/model"],
    ["", "org/model"],
    ["/cache", ""],
    ["/cache", "/"],
  ])("returns null for unusable input cacheDir=%s id=%s", (dir, id) => {
    expect(resolveModelCacheDir(dir as string | null, id)).toBeNull();
  });
});

describe("isTransformersInferenceDumpLine", () => {
  test.each([
    // The exact leading lines observed from transformers.js on a real WASM OOM
    // (models.js sessionRun catch → console.error x2), 8192-token input.
    'An error occurred during model execution: "286288496".',
    'An error occurred during model execution: "Missing the following inputs: attention_mask.',
    "Inputs given to model:",
  ])("matches the transformers inference-error dump line: %s", (line) => {
    expect(isTransformersInferenceDumpLine(line)).toBe(true);
  });

  test.each([
    // Non-string first args (e.g. the formatted-inputs object logged as the
    // SECOND console.error arg) must never match — only the leading string
    // line is dropped, which takes its trailing object with it.
    [{ input_ids: { data: new BigInt64Array(3) } }],
    [12345],
    [null],
    [undefined],
  ])("does NOT match a non-string arg: %s", (arg) => {
    expect(isTransformersInferenceDumpLine(arg)).toBe(false);
  });

  test.each([
    "[lore] ONNX OOM at ≤4962 tokens — respawning worker at a lower cap",
    "An error occurred", // truncated — not the transformers prefix
    "Error: something else entirely",
    "inputs given to model:", // case-sensitive: real line is capitalized
    "",
  ])("does NOT match unrelated console.error output: %s", (line) => {
    expect(isTransformersInferenceDumpLine(line)).toBe(false);
  });
});

describe("TRANSFORMERS_INFERENCE_DUMP_PREFIXES inline copy stays in sync", () => {
  // embedding-worker.ts inlines a byte-identical copy of both the prefixes AND
  // the isTransformersInferenceDumpLine predicate, because the worker is spawned
  // by Node's native resolver and can't runtime-import this `.ts` (same
  // constraint as isOomError/isWasmFatalError). The worker module executes
  // top-level code on import (it throws when parentPort is absent), so we can't
  // import its values — instead we parse them out of the source and assert they
  // match the canonical. This fails CI the moment the copies drift (data OR
  // logic), per the reviewer's request on PR #1120.
  const workerSrc = readFileSync(
    fileURLToPath(new URL("../src/embedding-worker.ts", import.meta.url)),
    "utf8",
  );
  const typesSrc = readFileSync(
    fileURLToPath(new URL("../src/embedding-worker-types.ts", import.meta.url)),
    "utf8",
  );

  test("worker source prefixes literal matches the canonical array", () => {
    const block = workerSrc.match(
      /const TRANSFORMERS_INFERENCE_DUMP_PREFIXES\s*=\s*\[([\s\S]*?)\]/,
    );
    expect(
      block,
      "inline prefixes array not found in embedding-worker.ts",
    ).not.toBeNull();
    const inline = [...(block?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1].replace(/\\(.)/g, "$1"),
    );
    expect(inline).toEqual([...TRANSFORMERS_INFERENCE_DUMP_PREFIXES]);
  });

  test("worker inline predicate body matches the canonical function", () => {
    // Extract the isTransformersInferenceDumpLine body from each source and
    // compare whitespace-normalized (robust to formatting). Guards against the
    // matching LOGIC drifting (e.g. startsWith→includes, dropping the typeof
    // guard) even when the prefix DATA is unchanged.
    const bodyOf = (src: string): string => {
      const m = src.match(
        /function isTransformersInferenceDumpLine\(arg: unknown\): boolean \{([\s\S]*?)\n\}/,
      );
      expect(
        m,
        "isTransformersInferenceDumpLine not found (worker or canonical)",
      ).not.toBeNull();
      return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
    };
    const workerBody = bodyOf(workerSrc);
    expect(workerBody.length).toBeGreaterThan(0);
    expect(workerBody).toBe(bodyOf(typesSrc));
  });

  test("worker inline isCorruptModelError body matches the canonical function", () => {
    // embedding-worker.ts inlines isCorruptModelError (same raw-.ts constraint).
    // It is the load-bearing component of the native→WASM respawn decision
    // (#1379): the worker's inline check `!vendorModel && isCorruptModelError &&
    // intact && usedNativeBinding` mirrors shouldRequestWasmRespawn(). If the
    // corruption classifier drifts, that decision silently drifts too — so guard
    // the inline copy against the canonical. Strip line comments first so this
    // asserts LOGIC parity only (the two copies carry different explanatory
    // comments by design).
    const bodyOf = (src: string): string => {
      const m = src.match(
        /function isCorruptModelError\(msg: string\): boolean \{([\s\S]*?)\n\}/,
      );
      expect(
        m,
        "isCorruptModelError not found (worker or canonical)",
      ).not.toBeNull();
      return (m?.[1] ?? "")
        .replace(/^\s*\/\/.*$/gm, "") // drop full-line // comments
        .replace(/\s+/g, " ")
        .trim();
    };
    const workerBody = bodyOf(workerSrc);
    expect(workerBody.length).toBeGreaterThan(0);
    expect(workerBody).toBe(bodyOf(typesSrc));
  });
});

describe("looksLikeIntactOnnxFile", () => {
  const OK = MIN_ONNX_FILE_BYTES + 1;

  test("true for a plausibly-sized file with the ONNX protobuf header (0x08)", () => {
    // ~137 MB nomic q8 model, first byte 0x08 (field 1 = ir_version).
    expect(looksLikeIntactOnnxFile(137_296_292, 0x08)).toBe(true);
    expect(looksLikeIntactOnnxFile(OK, 0x08)).toBe(true);
  });

  test("false when the file is too small (truncated / empty / error page)", () => {
    expect(looksLikeIntactOnnxFile(0, 0x08)).toBe(false);
    expect(looksLikeIntactOnnxFile(MIN_ONNX_FILE_BYTES - 1, 0x08)).toBe(false);
  });

  test("false when the header byte is not the ONNX protobuf tag", () => {
    // e.g. an HTML error page ('<' = 0x3c) saved as the model, or a bad head.
    expect(looksLikeIntactOnnxFile(OK, 0x3c)).toBe(false);
    expect(looksLikeIntactOnnxFile(OK, 0x00)).toBe(false);
    expect(looksLikeIntactOnnxFile(OK, undefined)).toBe(false);
  });
});

describe("shouldHealCorruptModel", () => {
  test("heals when not vendored and error is corruption", () => {
    expect(shouldHealCorruptModel(false, "Protobuf parsing failed.")).toBe(
      true,
    );
  });

  test("does NOT heal a vendored binary even on corruption", () => {
    // Vendored model is read-only / shipped in-binary — never delete/redownload.
    expect(shouldHealCorruptModel(true, "Protobuf parsing failed.")).toBe(
      false,
    );
  });

  test("does NOT heal on a non-corruption error", () => {
    expect(shouldHealCorruptModel(false, "out of memory")).toBe(false);
    expect(
      shouldHealCorruptModel(false, "401 Unauthorized: failed to load model"),
    ).toBe(false);
  });
});

describe("shouldRequestWasmRespawn (#1379)", () => {
  const PARSE = "Failed to load model because protobuf parsing failed";

  test("requests WASM respawn: native backend, intact file, parse error", () => {
    // The canonical Bun ↔ onnxruntime-node case — native loaded but couldn't
    // parse an intact model.
    expect(shouldRequestWasmRespawn(true, false, PARSE, true)).toBe(true);
  });

  test("does NOT request respawn when already on WASM", () => {
    // WASM can't fall back to itself; an intact-file parse failure there is the
    // existing retry-without-purge case, not a backend switch.
    expect(shouldRequestWasmRespawn(false, false, PARSE, true)).toBe(false);
  });

  test("does NOT request respawn for a vendored (SEA) binary", () => {
    // SEA ships its own native runtime and has no WASM sibling to fall back to.
    expect(shouldRequestWasmRespawn(true, true, PARSE, true)).toBe(false);
  });

  test("does NOT request respawn when the on-disk file is truncated", () => {
    // A genuinely corrupt/partial download is real corruption → purge path,
    // not a backend incompatibility.
    expect(shouldRequestWasmRespawn(true, false, PARSE, false)).toBe(false);
  });

  test("does NOT request respawn on a non-corruption error", () => {
    expect(shouldRequestWasmRespawn(true, false, "out of memory", true)).toBe(
      false,
    );
    expect(
      shouldRequestWasmRespawn(
        true,
        false,
        "401 Unauthorized: failed to load model",
        true,
      ),
    ).toBe(false);
  });
});

describe("shouldPostPerRequestError (#1379 B2)", () => {
  test("posts a per-request error for an ordinary embed failure", () => {
    // Normal per-request failure (no init failure, no pending respawn) → the
    // worker reports it so the main thread rejects just that request.
    expect(shouldPostPerRequestError(false, false)).toBe(true);
  });

  test("stays silent while a WASM respawn is pending (B2)", () => {
    // The request that tripped `init-needs-wasm` is rejected by ensurePipeline
    // with "awaiting WASM respawn". Posting a per-request error here would make
    // the main thread reject+drop the pending BEFORE respawnForWasm re-submits
    // it → the caller's embed is silently lost. Must NOT post.
    expect(shouldPostPerRequestError(false, true)).toBe(false);
  });

  test("stays silent after init already failed (init-error already posted)", () => {
    expect(shouldPostPerRequestError(true, false)).toBe(false);
  });

  test("stays silent when both flags are set", () => {
    expect(shouldPostPerRequestError(true, true)).toBe(false);
  });
});

describe("processEmbed catch condition stays in sync with shouldPostPerRequestError (#1379 B2)", () => {
  // shouldPostPerRequestError is the canonical, unit-tested B2 gate, but the
  // worker (raw .ts, self-executing on import — can't be imported here) inlines
  // the equivalent expression in processEmbed's catch. Parse the worker source
  // and assert that expression is exactly `!initFailed && !wasmRespawnRequested`
  // so the two can't silently drift (mirrors the isCorruptModelError inline-copy
  // guard above). If they drift, this fails CI and points at the worker.
  const workerSrc = readFileSync(
    fileURLToPath(new URL("../src/embedding-worker.ts", import.meta.url)),
    "utf8",
  );

  test("worker gates the per-request error post on both suppression flags", () => {
    // The catch opens with the B2 guard; match the exact boolean expression,
    // whitespace-normalized (robust to formatting/line wraps).
    const guard = workerSrc.match(
      /catch \(err\) \{[\s\S]*?if \(([^)]*initFailed[^)]*)\)/,
    );
    expect(guard, "processEmbed catch guard not found").not.toBeNull();
    const expr = (guard?.[1] ?? "").replace(/\s+/g, " ").trim();
    expect(expr).toBe("!initFailed && !wasmRespawnRequested");
  });
});
