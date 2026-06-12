import { describe, test, expect } from "vitest";
import {
  isOomError,
  isWasmFatalError,
  isCorruptModelError,
  resolveModelCacheDir,
  shouldHealCorruptModel,
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
