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

/**
 * Encode a negative value in zig-bsdiff sign-magnitude form: magnitude in the
 * lower 63 bits, sign in bit 63 (matches `offtin`, which is NOT two's
 * complement). `offtoutNeg(5)` decodes to -5.
 */
function offtoutNeg(magnitude: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(magnitude) | (1n << 63n), 0);
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

  it("rejects an implausibly large declared output size (OOM guard)", () => {
    // A malicious tiny patch declaring a multi-gigabyte newSize must be
    // rejected BEFORE any `new Uint8Array(newSize)` allocation. Build a valid
    // header/blocks but with newSize far above the 2 GiB ceiling.
    const control = zstdCompressSync(ctrl(2, 0, 0));
    const diff = zstdCompressSync(Buffer.from([0, 0]));
    const extra = zstdCompressSync(Buffer.alloc(0));
    const hugeNewSize = 8 * 1024 * 1024 * 1024; // 8 GiB
    const header = Buffer.concat([
      Buffer.from("TRDIFF10", "utf8"),
      offtout(control.length),
      offtout(diff.length),
      offtout(hugeNewSize),
    ]);
    const patch = Buffer.concat([header, control, diff, extra]);
    expect(() => parsePatchHeader(patch)).toThrow(/exceeds maximum/);
  });

  it("does not attempt to allocate the huge output before rejecting", async () => {
    // End-to-end: applyPatchToMemory must throw the header guard, never reach
    // `new Uint8Array(newSize)`. If the guard were absent this would OOM/RangeError
    // rather than throw the "exceeds maximum" message.
    const control = zstdCompressSync(ctrl(2, 0, 0));
    const diff = zstdCompressSync(Buffer.from([0, 0]));
    const extra = zstdCompressSync(Buffer.alloc(0));
    const hugeNewSize = 8 * 1024 * 1024 * 1024;
    const header = Buffer.concat([
      Buffer.from("TRDIFF10", "utf8"),
      offtout(control.length),
      offtout(diff.length),
      offtout(hugeNewSize),
    ]);
    const patch = Buffer.concat([header, control, diff, extra]);
    await expect(
      applyPatchToMemory(Buffer.from([1, 2]), patch),
    ).rejects.toThrow(/exceeds maximum/);
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

  it("zero-fills a window that starts before the file (negative oldpos)", async () => {
    // Drive oldpos negative via a negative seek larger than the bytes consumed,
    // then a diff-read whose window straddles the start-of-file boundary. The
    // leading out-of-range bytes must read as zero (FileOldReader.read outOffset
    // = start - pos path). offtin uses sign-magnitude, so encode -N explicitly.
    const old = Buffer.from([100, 101, 102, 103]);
    // tuple 1: read 2 diff bytes at oldpos 0 -> oldpos=2; seek -5 -> oldpos=-3.
    // tuple 2: read 4 diff bytes at oldpos -3 -> old[-3..0] are zero, old[0]=100.
    const control = Buffer.concat([
      ctrl(2, 0, 0),
      Buffer.concat([offtout(0), offtout(0), offtoutNeg(5)]), // seek -5
      ctrl(4, 0, 0),
    ]);
    const diff = Buffer.from([1, 1, 10, 20, 30, 40]);
    // Output: [100+1,101+1] then [0+10,0+20,0+30,100+40] (oldpos -3,-2,-1,0)
    const expected = Buffer.from([101, 102, 10, 20, 30, 140]);
    const patch = buildPatch({
      control,
      diff,
      extra: Buffer.alloc(0),
      newSize: 6,
    });

    const oldPath = writeTemp("neg-old.bin", old);
    const destPath = join(WORK_DIR, "neg-new.bin");
    const hash = await applyPatch(oldPath, patch, destPath);

    const written = await readFile(destPath);
    expect(written).toEqual(expected);
    expect(hash).toBe(sha256(expected));
  });

  it("serves a base larger than the 1 MiB read-ahead block across straddles and a backward seek", async () => {
    // Base spans 3 read-ahead blocks (1 MiB each). Read in SMALL windows so the
    // FileOldReader cache is actually used (windows <= block size), forcing:
    //  - a refill when a window crosses a 1 MiB boundary,
    //  - a refill when a window jumps into a later block,
    //  - a BACKWARD jump into an already-evicted earlier block (stale-cache trap).
    // A broken cache (never refills / ignores block bounds) serves wrong bytes
    // for the later/backward reads and fails the hash.
    const BLOCK = 1024 * 1024;
    const size = 3 * BLOCK + 512; // 3 full blocks + a tail
    const old = Buffer.alloc(size);
    for (let i = 0; i < size; i++) old[i] = (i * 2654435761) & 0xff;

    // Windows (each a diff-read of `len` at the current oldpos), with seeks to
    // move oldpos between them. offtin seek is applied AFTER advancing oldpos by
    // the diff length, so seek = targetNextPos - (posAfterThisRead).
    type Win = { pos: number; len: number };
    const wins: Win[] = [
      { pos: 0, len: 64 }, // block 0
      { pos: BLOCK - 16, len: 32 }, // straddle block 0/1 -> refill
      { pos: 2 * BLOCK + 100, len: 64 }, // jump to block 2 -> refill
      { pos: 10, len: 64 }, // BACKWARD to block 0 (evicted) -> refill
      { pos: BLOCK + 5, len: 64 }, // block 1 -> refill
    ];

    // Emit seek-first semantics: a zero-read seek tuple to the window start,
    // then the diff-read tuple. The control loop applies the diff read at the
    // current oldpos, then applies the seek — so the seek must precede the read.
    const control2: Buffer[] = [];
    const diffParts: Buffer[] = [];
    const expectedParts: number[] = [];
    let cur = 0;
    for (const w of wins) {
      const seekTo = w.pos - cur;
      control2.push(
        Buffer.concat([
          offtout(0),
          offtout(0),
          seekTo >= 0 ? offtout(seekTo) : offtoutNeg(-seekTo),
        ]),
      );
      control2.push(ctrl(w.len, 0, 0));
      const d = Buffer.alloc(w.len);
      for (let i = 0; i < w.len; i++) {
        d[i] = (w.pos * 3 + i * 7) & 0xff;
        expectedParts.push((old[w.pos + i] + d[i]) % 256);
      }
      diffParts.push(d);
      cur = w.pos + w.len;
    }

    const totalLen = wins.reduce((s, w) => s + w.len, 0);
    const patch = buildPatch({
      control: Buffer.concat(control2),
      diff: Buffer.concat(diffParts),
      extra: Buffer.alloc(0),
      newSize: totalLen,
    });
    const expected = Buffer.from(expectedParts);

    const oldPath = writeTemp("big-old.bin", old);
    const destPath = join(WORK_DIR, "big-new.bin");
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
