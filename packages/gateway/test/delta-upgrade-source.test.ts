import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PatchChain } from "binpatch";

const state = vi.hoisted(() => ({ chain: null as PatchChain | null }));
vi.mock("../src/cli/version", () => ({ VERSION: "1.0.0-dev.100" }));
vi.mock("binpatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("binpatch")>()),
  ghcrSource: () => ({ resolveChain: async () => state.chain }),
}));
import {
  attemptDeltaUpgrade,
  prefetchNightlyPatches,
} from "../src/cli/lib/delta-upgrade";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

it.each([false, true])(
  "quietly skips a same-version rebuilt base (prefetched=%s)",
  async (prefetched) => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-base-"));
    roots.push(root);
    vi.stubEnv("LORE_CONFIG_DIR", root);
    const oldPath = join(root, "old");
    const dest = join(root, "output");
    writeFileSync(oldPath, "rebuilt base");
    writeFileSync(dest, "untouched");
    // Invalid patch bytes are deliberate: a source mismatch must skip BEFORE parsing/applying them.
    const data = Buffer.from("not a patch");
    state.chain = {
      patches: [{ data, size: data.length }],
      totalSize: data.length,
      sourceSha256: createHash("sha256").update("official base").digest("hex"),
      expectedSha256: "a".repeat(64),
      steps: [{ fromVersion: "1.0.0-dev.100", toVersion: "1.0.0-dev.101" }],
    };
    if (prefetched) await prefetchNightlyPatches("1.0.0-dev.101");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await attemptDeltaUpgrade("1.0.0-dev.101", oldPath, dest, prefetched),
    ).toBeNull();
    expect(readFileSync(dest, "utf8")).toBe("untouched");
    expect(errors).not.toHaveBeenCalled();
  },
);
