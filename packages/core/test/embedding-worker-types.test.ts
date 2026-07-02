import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  isOomError,
  isWasmFatalError,
  isCorruptModelError,
  isTransformersInferenceDumpLine,
  resolveModelCacheDir,
  shouldHealCorruptModel,
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
