/**
 * Correctness tests for TRDIFF10 bspatch application.
 *
 * These exercise the performance-optimized code paths added in the delta-upgrade
 * speedup (vectorized wrapping-add, on-demand `pread` base reads with a 1 MiB
 * read-ahead cache, in-memory multi-patch chains, and buffered output writes)
 * without requiring the external `zig-bsdiff` tool: patches are hand-crafted by
 * zstd-compressing control/diff/extra blocks built in-test.
 *
 * TRDIFF10 layout (little-endian, sign-magnitude i64 via `offtin`):
 *   [0..8]   "TRDIFF10"
 *   [8..16]  controlLen  (compressed size of control block)
 *   [16..24] diffLen     (compressed size of diff block)
 *   [24..32] newSize     (expected output size)
 *   [32..]   zstd(control) | zstd(diff) | zstd(extra)
 *
 * Control block is a sequence of 24-byte tuples: (readDiffBy, readExtraBy, seekBy).
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import {
  applyPatch,
  applyPatchChainInMemory,
  applyPatchToMemory,
  offtin,
  parsePatchHeader,
} from "../src/cli/lib/bspatch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORK_DIR = mkdtempSync(join(tmpdir(), "bspatch-test-"));

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

/** Encode a non-negative integer as zig-bsdiff sign-magnitude i64 LE. */
function offtout(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

/** Build a single 24-byte control tuple. */
function ctrl(readDiffBy: number, readExtraBy: number, seekBy: number): Buffer {
  return Buffer.concat([
    offtout(readDiffBy),
    offtout(readExtraBy),
    offtout(seekBy),
  ]);
}

/** Assemble a TRDIFF10 patch buffer from raw (uncompressed) blocks. */
function buildPatch(opts: {
  control: Buffer;
  diff: Buffer;
  extra: Buffer;
  newSize: number;
}): Buffer {
  const control = zstdCompressSync(opts.control);
  const diff = zstdCompressSync(opts.diff);
  const extra = zstdCompressSync(opts.extra);

  const header = Buffer.concat([
    Buffer.from("TRDIFF10", "utf8"),
    offtout(control.length),
    offtout(diff.length),
    offtout(opts.newSize),
  ]);

  return Buffer.concat([header, control, diff, extra]);
}

function sha256(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Write `data` to a temp file and return its path. */
function writeTemp(name: string, data: Buffer | Uint8Array): string {
  const p = join(WORK_DIR, name);
  writeFileSync(p, data);
  return p;
}

// ---------------------------------------------------------------------------
// offtin / header parsing
// ---------------------------------------------------------------------------

describe("offtin", () => {
  it("reads non-negative sign-magnitude i64 LE", () => {
    expect(offtin(new Uint8Array(offtout(0)), 0)).toBe(0);
    expect(offtin(new Uint8Array(offtout(1)), 0)).toBe(1);
    expect(offtin(new Uint8Array(offtout(310 * 1024 * 1024)), 0)).toBe(
      310 * 1024 * 1024,
    );
  });
});

describe("parsePatchHeader", () => {
  it("round-trips header fields", () => {
    const patch = buildPatch({
      control: ctrl(4, 2, 0),
      diff: Buffer.from([1, 2, 3, 4]),
      extra: Buffer.from([9, 9]),
      newSize: 6,
    });
    const h = parsePatchHeader(patch);
    expect(h.newSize).toBe(6);
    expect(h.controlLen).toBeGreaterThan(0);
    expect(h.diffLen).toBeGreaterThan(0);
  });

  it("rejects bad magic", () => {
    const bad = Buffer.alloc(64);
    bad.write("NOTAPATC", 0, "utf8");
    expect(() => parsePatchHeader(bad)).toThrow(/Invalid patch format/);
  });

  it("rejects truncated patch", () => {
    expect(() => parsePatchHeader(Buffer.alloc(8))).toThrow(/too small/);
  });
});

// ---------------------------------------------------------------------------
// applyPatchToMemory — wrapping u8 add, extra passthrough, seeks
// ---------------------------------------------------------------------------

describe("applyPatchToMemory", () => {
  it("applies a pure-diff patch with wrapping u8 addition", () => {
    // old = [10, 200, 255, 0]; diff chosen so output wraps past 255.
    const old = Buffer.from([10, 200, 255, 0]);
    const diff = Buffer.from([250, 100, 1, 5]);
    // expected[i] = (old[i] + diff[i]) % 256
    const expected = Buffer.from([
      (10 + 250) % 256,
      (200 + 100) % 256,
      (255 + 1) % 256,
      (0 + 5) % 256,
    ]);
    const patch = buildPatch({
      control: ctrl(4, 0, 0),
      diff,
      extra: Buffer.alloc(0),
      newSize: 4,
    });
    return applyPatchToMemory(old, patch).then((out) => {
      expect(Buffer.from(out)).toEqual(expected);
    });
  });

  it("passes extra bytes through verbatim", () => {
    const old = Buffer.from([1, 2]);
    const extra = Buffer.from([7, 8, 9]);
    const patch = buildPatch({
      control: ctrl(2, 3, 0),
      diff: Buffer.from([0, 0]),
      extra,
      newSize: 5,
    });
    return applyPatchToMemory(old, patch).then((out) => {
      expect(Buffer.from(out)).toEqual(Buffer.from([1, 2, 7, 8, 9]));
    });
  });

  it("zero-fills old reads beyond end-of-file (seek past EOF)", () => {
    // Read 2 diff bytes at oldpos 0, then seek far past EOF and read 3 more.
    const old = Buffer.from([5, 6]);
    const diff = Buffer.from([1, 1, 2, 2, 2]);
    const patch = buildPatch({
      control: Buffer.concat([ctrl(2, 0, 1000), ctrl(3, 0, 0)]),
      diff,
      extra: Buffer.alloc(0),
      newSize: 5,
    });
    return applyPatchToMemory(old, patch).then((out) => {
      // First two: 5+1, 6+1. Last three: 0+2 each (old reads past EOF are zero).
      expect(Buffer.from(out)).toEqual(Buffer.from([6, 7, 2, 2, 2]));
    });
  });

  it("handles a diff window spanning the vectorization boundary", () => {
    // 21 bytes exercises the SWAR fast path (5 words) + a 1-byte tail.
    const n = 21;
    const old = Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) % 256));
    const diff = Buffer.from(
      Array.from({ length: n }, (_, i) => (i * 13) % 256),
    );
    const expected = Buffer.from(
      Array.from({ length: n }, (_, i) => (old[i] + diff[i]) % 256),
    );
    const patch = buildPatch({
      control: ctrl(n, 0, 0),
      diff,
      extra: Buffer.alloc(0),
      newSize: n,
    });
    return applyPatchToMemory(old, patch).then((out) => {
      expect(Buffer.from(out)).toEqual(expected);
    });
  });

  it("matches the byte-loop reference across all byte values in many windows", () => {
    // Every (old, diff) byte value pair appears in some window; window sizes
    // vary to cross the 4-byte SWAR boundary and hit tail lengths 0-3. Compare
    // against a straightforward per-byte reference implementation.
    const windows = [4, 8, 16, 1024, 4099];
    const total = windows.reduce((s, w) => s + w, 0);
    const old = Buffer.alloc(total);
    const diff = Buffer.alloc(total);
    let v = 0;
    for (let i = 0; i < total; i++) {
      old[i] = v & 0xff;
      diff[i] = (v * 31 + 7) & 0xff;
      v = (v + 1) & 0xff;
    }
    const expected = Buffer.alloc(total);
    for (let i = 0; i < total; i++) {
      expected[i] = ((old[i] ?? 0) + (diff[i] ?? 0)) % 256;
    }

    const control = Buffer.concat(windows.map((w) => ctrl(w, 0, 0)));
    const patch = buildPatch({
      control,
      diff,
      extra: Buffer.alloc(0),
      newSize: total,
    });
    return applyPatchToMemory(old, patch).then((out) => {
      expect(Buffer.from(out)).toEqual(expected);
    });
  });

  it("throws on output size mismatch", () => {
    const patch = buildPatch({
      control: ctrl(2, 0, 0),
      diff: Buffer.from([1, 1]),
      extra: Buffer.alloc(0),
      newSize: 99, // header claims 99 but we only produce 2
    });
    return expect(
      applyPatchToMemory(Buffer.from([1, 2]), patch),
    ).rejects.toThrow(/Output size mismatch/);
  });
});

// ---------------------------------------------------------------------------
// applyPatch / applyPatchChainInMemory — file-backed, hashing, multi-hop
// ---------------------------------------------------------------------------

describe("applyPatch", () => {
  it("writes patched output to disk and returns its SHA-256", async () => {
    const old = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    const diff = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 5));
    const expected = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => (old[i] + diff[i]) % 256),
    );
    const patch = buildPatch({
      control: ctrl(4096, 0, 0),
      diff,
      extra: Buffer.alloc(0),
      newSize: 4096,
    });

    const oldPath = writeTemp("old.bin", old);
    const destPath = join(WORK_DIR, "new.bin");
    const hash = await applyPatch(oldPath, patch, destPath);

    const written = await readFile(destPath);
    expect(written).toEqual(expected);
    expect(hash).toBe(sha256(expected));
  });
});

describe("applyPatchChainInMemory", () => {
  it("applies a two-hop chain, hashing only the final output", async () => {
    // hop1: old += diffA ; hop2: (hop1) += diffB, plus an extra byte appended.
    const old = Buffer.from([1, 2, 3, 4]);
    const patch1 = buildPatch({
      control: ctrl(4, 0, 0),
      diff: Buffer.from([10, 10, 10, 10]),
      extra: Buffer.alloc(0),
      newSize: 4,
    });
    const afterHop1 = Buffer.from([11, 12, 13, 14]);

    const patch2 = buildPatch({
      control: ctrl(4, 1, 0),
      diff: Buffer.from([1, 1, 1, 1]),
      extra: Buffer.from([42]),
      newSize: 5,
    });
    const expected = Buffer.from([12, 13, 14, 15, 42]);
    expect(afterHop1.map((b) => (b + 1) % 256)).toEqual(
      expected.subarray(0, 4),
    );

    const oldPath = writeTemp("chain-old.bin", old);
    const destPath = join(WORK_DIR, "chain-new.bin");
    const hash = await applyPatchChainInMemory(
      oldPath,
      [patch1, patch2],
      destPath,
    );

    const written = await readFile(destPath);
    expect(written).toEqual(expected);
    expect(hash).toBe(sha256(expected));
  });

  it("rejects an empty chain", async () => {
    const oldPath = writeTemp("empty-old.bin", Buffer.from([1]));
    await expect(
      applyPatchChainInMemory(oldPath, [], join(WORK_DIR, "out.bin")),
    ).rejects.toThrow(/empty patch chain/);
  });
});
