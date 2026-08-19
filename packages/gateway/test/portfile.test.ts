import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@loreai/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  inspectPortFile,
  readPortFile,
  removePortFile,
  writePortFile,
} from "../src/portfile";

let base: string;
let previousXdg: string | undefined;

beforeEach(() => {
  previousXdg = process.env.XDG_DATA_HOME;
  base = mkdtempSync(join(tmpdir(), "lore-portfile-test-"));
  process.env.XDG_DATA_HOME = base;
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(base, { recursive: true, force: true });
});

describe("portfile", () => {
  test("round-trips and overwrites legacy port values", () => {
    expect(readPortFile()).toBeNull();
    writePortFile(3207);
    expect(readPortFile()).toBe(3207);
    writePortFile(5673);
    expect(readPortFile()).toBe(5673);
  });

  test("restores owner-only permissions when replacing a file", () => {
    if (process.platform === "win32") return;
    writePortFile(3207);
    chmodSync(join(dataDir(), "gateway.port"), 0o666);
    writePortFile(5673);
    expect(lstatSync(join(dataDir(), "gateway.port")).mode & 0o777).toBe(0o600);
  });

  test("legacy cleanup removes only a matching port", () => {
    writePortFile(5673);
    removePortFile(3207);
    expect(readPortFile()).toBe(5673);
    removePortFile(5673);
    expect(readPortFile()).toBeNull();
    expect(() => removePortFile(5673)).not.toThrow();
  });

  test("rejects invalid legacy content", () => {
    writePortFile(0);
    expect(readPortFile()).toBeNull();
    writePortFile(70000);
    expect(readPortFile()).toBeNull();
  });

  test("strict inspection distinguishes absent from legacy invalid evidence", () => {
    expect(inspectPortFile()).toEqual({ state: "absent" });
    writePortFile(3207);
    expect(inspectPortFile()).toMatchObject({ state: "invalid" });
  });

  test("round-trips an authenticated generation record", () => {
    const token = "owner".repeat(8);
    writePortFile(3207, token);
    expect(readPortFile()).toBe(3207);
    expect(inspectPortFile()).toEqual({
      state: "valid",
      record: { version: 1, port: 3207, token },
    });
  });

  test("token cleanup preserves a same-port successor", () => {
    const successorToken = "successor".repeat(4);
    writePortFile(3207, successorToken);
    removePortFile(3207, "predecessor".repeat(4));
    expect(inspectPortFile()).toEqual({
      state: "valid",
      record: { version: 1, port: 3207, token: successorToken },
    });
  });
});
