import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { buildVersion, stagingVersion } from "../script/build-version";
import { valid, parse } from "semver";

describe("build version identity", () => {
  it.each(["0.40.0", "1.0.0-dev.1792278708", "1.0.0+existing"])(
    "gives each local build of %s a distinct semver identity",
    (version) => {
      const first = buildVersion(version, false);
      const second = buildVersion(version, false);
      expect(valid(first)).not.toBeNull();
      expect(parse(first)?.raw).toBe(first);
      expect(first).toMatch(/\+.*local\./);
      expect(first).not.toBe(second);
      expect(first).not.toBe(version);
    },
  );
  it("preserves explicit official release versions", () => {
    expect(buildVersion("1.0.0-dev.123", true)).toBe("1.0.0-dev.123");
    expect(buildVersion("0.40.0", true)).toBe("0.40.0");
  });
  it("injects the distinct version into the actual CLI version module", async () => {
    const version = buildVersion("1.0.0-dev.123", false);
    const root = mkdtempSync(join(tmpdir(), "lore-build-version-"));
    try {
      const outfile = join(root, "version.cjs");
      await build({
        entryPoints: [
          new URL("../src/cli/version.ts", import.meta.url).pathname,
        ],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile,
        define: { LORE_CLI_VERSION: JSON.stringify(version) },
      });
      const actual = execFileSync(
        process.execPath,
        [
          "-e",
          "process.stdout.write(require(process.argv[1]).VERSION)",
          outfile,
        ],
        { encoding: "utf8" },
      );
      expect(actual).toBe(version);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("skips delta resolution for locally built versions", async () => {
    vi.doMock("../src/cli/version", () => ({
      VERSION: buildVersion("1.0.0-dev.123", false),
    }));
    const { canAttemptDelta } = await import("../src/cli/lib/delta-upgrade");
    expect(canAttemptDelta("1.0.0-dev.124")).toBe(false);
    vi.doUnmock("../src/cli/version");
  });
});

it("preserves local staging identity and refuses official staging in a local rebuild", () => {
  const local = buildVersion("1.0.0", false);
  expect(stagingVersion(local, "1.0.0", false)).toBe(local);
  expect(stagingVersion("1.0.0", "1.0.0", true)).toBe("1.0.0");
  expect(() => stagingVersion("1.0.0", "1.0.0", false)).toThrow("regenerate");
  expect(() => stagingVersion(local, "1.0.0", true)).toThrow("regenerate");
  expect(() => stagingVersion("1.0.0", "1.0.1", true)).toThrow("regenerate");
});
