import { describe, test, expect } from "vitest";
import {
  isOomError,
  isWasmFatalError,
  isCorruptModelError,
} from "../src/embedding-worker-types";

describe("isCorruptModelError", () => {
  test("matches the real truncated-download error from ONNX", () => {
    // The exact message observed when a 137MB model only downloaded ~87MB.
    const msg =
      "Load model from /home/.../onnx/model_quantized.onnx failed:Protobuf parsing failed.";
    expect(isCorruptModelError(msg)).toBe(true);
  });

  test.each([
    "Protobuf parsing failed.",
    "protobuf parsing failed",
    "Load model from foo.onnx failed: bad data",
    "Failed to load model: unexpected EOF",
    "invalid model file",
    "model appears corrupt",
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

  test("is disjoint from OOM/WASM-fatal classification for OOM codes", () => {
    // An OOM numeric code must not be treated as a corrupt model (it would
    // trigger a pointless re-download instead of the correct fatal handling).
    const oom = "287180544";
    expect(isOomError(oom)).toBe(true);
    expect(isWasmFatalError(oom)).toBe(true);
    expect(isCorruptModelError(oom)).toBe(false);
  });
});
