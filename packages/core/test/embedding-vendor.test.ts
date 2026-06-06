/**
 * Tests for the vendor-registration module used by the standalone Lore
 * binary. The runtime module is intentionally tiny — it just exposes
 * the model-path registration set by the binary's wrapper. These tests
 * verify the binary-mode / npm-mode contract that the LocalProvider
 * relies on.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isVendoredBinary,
  vendorModelInfo,
  vendorRegistration,
  _setVendorRegistration,
  LOCAL_MODEL_PATH_ENV,
} from "../src/embedding-vendor";

// These tests verify the binary-mode / npm-mode contract of the vendor module.
// LORE_LOCAL_MODEL_PATH (set by CI to point at the vendored model cache) would
// override vendorModelInfo(), so we clear it for the duration of these tests.
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[LOCAL_MODEL_PATH_ENV];
  delete process.env[LOCAL_MODEL_PATH_ENV];
});

afterEach(() => {
  _setVendorRegistration(null);
  if (savedEnv !== undefined) process.env[LOCAL_MODEL_PATH_ENV] = savedEnv;
  else delete process.env[LOCAL_MODEL_PATH_ENV];
});

describe("npm mode (no registration)", () => {
  test("isVendoredBinary returns false", () => {
    expect(isVendoredBinary()).toBe(false);
  });

  test("vendorRegistration returns null", () => {
    expect(vendorRegistration()).toBeNull();
  });

  test("vendorModelInfo returns null", () => {
    expect(vendorModelInfo()).toBeNull();
  });
});

describe("binary mode (registration set)", () => {
  test("isVendoredBinary returns true once registration is set", () => {
    _setVendorRegistration({
      localModelPath: "/home/user/.lore/embeddings-vendored/v1.0.0-linux-x64",
      target: "linux-x64",
      version: "9.9.9",
    });
    expect(isVendoredBinary()).toBe(true);
  });

  test("vendorRegistration returns the full record (for diagnostics)", () => {
    const reg = {
      localModelPath:
        "/home/user/.lore/embeddings-vendored/v0.16.0-darwin-arm64",
      target: "darwin-arm64",
      version: "0.16.0",
    };
    _setVendorRegistration(reg);
    expect(vendorRegistration()).toEqual(reg);
  });

  test("vendorModelInfo strips diagnostic fields", () => {
    _setVendorRegistration({
      localModelPath: "/home/user/.lore/embeddings-vendored/v9.9.9-linux-x64",
      target: "linux-x64",
      version: "9.9.9",
    });
    const info = vendorModelInfo();
    expect(info).toEqual({
      localModelPath: "/home/user/.lore/embeddings-vendored/v9.9.9-linux-x64",
    });
    // The full type isn't leaked through vendorModelInfo — target /
    // version are diagnostic-only and shouldn't make it into the
    // transformers.js env config.
    expect(info).not.toHaveProperty("target");
    expect(info).not.toHaveProperty("version");
  });

  test("clearing the registration reverts to npm-mode behaviour", () => {
    _setVendorRegistration({
      localModelPath: "/x",
      target: "linux-x64",
      version: "0",
    });
    expect(isVendoredBinary()).toBe(true);
    _setVendorRegistration(null);
    expect(isVendoredBinary()).toBe(false);
    expect(vendorModelInfo()).toBeNull();
  });
});

describe("env override (LORE_LOCAL_MODEL_PATH)", () => {
  test("existing directory is used as localModelPath", () => {
    // /tmp always exists and is a directory on Linux/macOS.
    process.env[LOCAL_MODEL_PATH_ENV] = "/tmp";
    expect(vendorModelInfo()).toEqual({ localModelPath: "/tmp" });
  });

  test("non-existent path falls through to null", () => {
    process.env[LOCAL_MODEL_PATH_ENV] = "/nonexistent/vendor/path-42";
    expect(vendorModelInfo()).toBeNull();
  });

  test("empty string falls through to null", () => {
    process.env[LOCAL_MODEL_PATH_ENV] = "";
    expect(vendorModelInfo()).toBeNull();
  });

  test("regular file (not a directory) falls through to null", () => {
    // package.json exists and is a regular file, not a directory.
    const { resolve } = require("node:path") as typeof import("node:path");
    process.env[LOCAL_MODEL_PATH_ENV] = resolve(__dirname, "../package.json");
    expect(vendorModelInfo()).toBeNull();
  });

  test("env override takes precedence over binary registration", () => {
    // Both sources are set — env must win.
    process.env[LOCAL_MODEL_PATH_ENV] = "/tmp";
    _setVendorRegistration({
      localModelPath: "/home/user/.lore/vendor-binary",
      target: "linux-x64",
      version: "1.0.0",
    });
    const info = vendorModelInfo();
    expect(info).toEqual({ localModelPath: "/tmp" });
    // The binary registration is still readable via vendorRegistration()
    // (diagnostic), but vendorModelInfo() returns the env override.
    expect(vendorRegistration()).not.toBeNull();
  });

  test("isVendoredBinary is NOT affected by env override", () => {
    // LORE_LOCAL_MODEL_PATH is for air-gapped/CI use, not a binary.
    process.env[LOCAL_MODEL_PATH_ENV] = "/tmp";
    expect(isVendoredBinary()).toBe(false);
  });
});
