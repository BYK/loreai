import { describe, expect, it } from "vitest";
import {
  currentTarget,
  getLoadablePath,
  getLoadablePathForTarget,
  VEC_TARGETS,
  vecFileName,
} from "@loreai/sqlite-vec-vendored";

/** Pack a JS number[] as a little-endian float32 blob for vec0. */
function f32(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) buf.writeFloatLE(values[i], i * 4);
  return buf;
}

describe("@loreai/sqlite-vec-vendored path resolution", () => {
  it("exposes the four supported targets with correct extensions", () => {
    expect([...VEC_TARGETS]).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-arm64",
      "windows-x64",
    ]);
    expect(vecFileName("linux-x64")).toBe("vec0.so");
    expect(vecFileName("linux-arm64")).toBe("vec0.so");
    expect(vecFileName("darwin-arm64")).toBe("vec0.dylib");
    expect(vecFileName("windows-x64")).toBe("vec0.dll");
  });

  it("resolves a per-target path ending in the right artifact name", () => {
    for (const t of VEC_TARGETS) {
      expect(getLoadablePathForTarget(t)).toMatch(
        new RegExp(
          `prebuilt[\\\\/]${t}[\\\\/]${vecFileName(t).replace(".", "\\.")}$`,
        ),
      );
    }
  });

  it("returns a real binary path on supported platforms", () => {
    const t = currentTarget();
    if (!t) return; // unsupported platform — nothing to assert
    // The committed binary for the host platform must resolve.
    expect(getLoadablePath()).toBe(getLoadablePathForTarget(t));
  });
});

describe("@loreai/sqlite-vec-vendored extension load", () => {
  it("loads, reports v0.1.10, and runs a DiskANN int8 KNN query", async (ctx) => {
    const path = getLoadablePath();
    if (!path) return ctx.skip(); // no binary for this platform

    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return ctx.skip(); // node:sqlite unavailable in this runtime
    }

    const db = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      db.loadExtension(path);

      const version = (
        db.prepare("SELECT vec_version() AS v").get() as { v: string }
      ).v;
      expect(version.startsWith("v0.1.10")).toBe(true);

      // Exercise the DiskANN int8 quantizer path — the one patch 0001 fixes.
      db.exec(
        "CREATE VIRTUAL TABLE d USING vec0(" +
          "id TEXT PRIMARY KEY, " +
          "emb float[4] distance_metric=cosine " +
          "INDEXED BY diskann(neighbor_quantizer=int8))",
      );
      const ins = db.prepare("INSERT INTO d(id, emb) VALUES (?, ?)");
      ins.run("a", f32([1, 0, 0, 0]));
      ins.run("b", f32([0, 1, 0, 0]));
      ins.run("c", f32([0.9, 0.1, 0, 0]));

      const rows = db
        .prepare(
          "SELECT id, distance FROM d WHERE emb MATCH ? AND k = 3 ORDER BY distance",
        )
        .all(f32([1, 0, 0, 0])) as Array<{ id: string; distance: number }>;

      expect(rows.map((r) => r.id)).toEqual(["a", "c", "b"]);
      expect(rows[0].distance).toBeCloseTo(0, 5);
    } finally {
      db.close();
    }
  });
});
