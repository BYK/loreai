/**
 * Orchestration tests for resolveAndApply — the cache-first / network /
 * offline / verify decision logic and progress-event emission. Uses real
 * hand-crafted TRDIFF10 patches (a pure-extra passthrough patch: it ignores
 * the old file and emits `extra` verbatim) so we exercise the genuine apply +
 * SHA-256 path, and fake SourceStrategy/PatchCache to drive the branches.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  type PatchCache,
  type PatchChain,
  type ProgressEvent,
  resolveAndApply,
  type SourceStrategy,
} from "../src";

const WORK_DIR = mkdtempSync(join(tmpdir(), "discover-test-"));
afterAll(() => rmSync(WORK_DIR, { recursive: true, force: true }));

function offtout(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

/** Build a pure-passthrough TRDIFF10 patch that emits `extra` verbatim. */
function passthroughPatch(extra: Buffer): Uint8Array {
  const control = zstdCompressSync(
    Buffer.concat([offtout(0), offtout(extra.length), offtout(0)]),
  );
  const diff = zstdCompressSync(Buffer.alloc(0));
  const extraZ = zstdCompressSync(extra);
  const header = Buffer.concat([
    Buffer.from("TRDIFF10", "utf8"),
    offtout(control.length),
    offtout(diff.length),
    offtout(extra.length),
  ]);
  return new Uint8Array(Buffer.concat([header, control, diff, extraZ]));
}

function sha256(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function writeTemp(name: string, data: Buffer | Uint8Array): string {
  const p = join(WORK_DIR, name);
  writeFileSync(p, data);
  return p;
}

/** A single-hop chain producing `output` from any old file. */
function makeChain(output: Buffer): PatchChain {
  const patch = passthroughPatch(output);
  return {
    patches: [{ data: patch, size: patch.byteLength }],
    totalSize: patch.byteLength,
    expectedSha256: sha256(output),
    steps: [{ fromVersion: "1.0.0", toVersion: "1.1.0" }],
  };
}

const OLD = writeTemp("old.bin", Buffer.from("old binary contents"));

describe("resolveAndApply", () => {
  it("applies a chain resolved from the network and reports source=network", async () => {
    const output = Buffer.from("the new binary payload");
    const chain = makeChain(output);
    const source: SourceStrategy = { resolveChain: vi.fn(async () => chain) };
    const onResolved = vi.fn();
    const dest = writeTemp("out-network.bin", Buffer.alloc(0));

    const result = await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      telemetry: { onResolved },
    });

    expect(result).not.toBeNull();
    expect(result?.sha256).toBe(chain.expectedSha256);
    expect(result?.chainLength).toBe(1);
    expect(onResolved).toHaveBeenCalledWith({ source: "network", chain });
    expect(new Uint8Array(await readFile(dest))).toEqual(
      new Uint8Array(output),
    );
  });

  it("checks the cache first and never touches the source on a hit", async () => {
    const output = Buffer.from("cached payload!!");
    const chain = makeChain(output);
    const cache: PatchCache = {
      save: vi.fn(async () => {}),
      load: vi.fn(async () => chain),
      cleanup: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const source: SourceStrategy = { resolveChain: vi.fn(async () => null) };
    const onResolved = vi.fn();
    const dest = writeTemp("out-cache.bin", Buffer.alloc(0));

    const result = await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      cache,
      telemetry: { onResolved },
    });

    expect(result?.sha256).toBe(chain.expectedSha256);
    expect(cache.load).toHaveBeenCalledOnce();
    expect(source.resolveChain).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith({ source: "cache", chain });
  });

  it("saves a network-resolved chain to the cache", async () => {
    const chain = makeChain(Buffer.from("save me"));
    const cache: PatchCache = {
      save: vi.fn(async () => {}),
      load: vi.fn(async () => null),
      cleanup: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const source: SourceStrategy = { resolveChain: vi.fn(async () => chain) };
    const dest = writeTemp("out-save.bin", Buffer.alloc(0));

    await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      cache,
    });

    expect(cache.save).toHaveBeenCalledWith(chain, chain.steps);
  });

  it("returns null and fires onOfflineMiss when offline with no cache hit", async () => {
    const cache: PatchCache = {
      save: vi.fn(async () => {}),
      load: vi.fn(async () => null),
      cleanup: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const source: SourceStrategy = { resolveChain: vi.fn(async () => null) };
    const onOfflineMiss = vi.fn();
    const dest = writeTemp("out-offline.bin", Buffer.alloc(0));

    const result = await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      cache,
      offline: true,
      telemetry: { onOfflineMiss },
    });

    expect(result).toBeNull();
    expect(onOfflineMiss).toHaveBeenCalledOnce();
    // Offline must never hit the network.
    expect(source.resolveChain).not.toHaveBeenCalled();
  });

  it("returns null when the source has no usable chain", async () => {
    const source: SourceStrategy = { resolveChain: vi.fn(async () => null) };
    const dest = writeTemp("out-none.bin", Buffer.alloc(0));

    const result = await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
    });

    expect(result).toBeNull();
  });

  it("fires onUnavailable('malformed_chain') when the source classifies a broken chain", async () => {
    // A source that finds patch tags in range but a broken/missing-layer
    // manifest reports `malformed_chain` — the poisoned-publish signal.
    const source: SourceStrategy = {
      resolveChain: vi.fn(async (_current, _target, _signal, report) => {
        report?.("malformed_chain");
        return null;
      }),
    };
    const onUnavailable = vi.fn();
    const dest = writeTemp("out-malformed.bin", Buffer.alloc(0));

    const result = await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      telemetry: { onUnavailable },
    });

    expect(result).toBeNull();
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("malformed_chain");
  });

  it("defaults onUnavailable to 'no_patches' when the source reports nothing", async () => {
    const source: SourceStrategy = { resolveChain: vi.fn(async () => null) };
    const onUnavailable = vi.fn();
    const dest = writeTemp("out-nopatches.bin", Buffer.alloc(0));

    const result = await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      telemetry: { onUnavailable },
    });

    expect(result).toBeNull();
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("no_patches");
  });

  it("throws on a SHA-256 mismatch (caller falls back to full download)", async () => {
    const chain = makeChain(Buffer.from("real output"));
    // Corrupt the expected hash so the applied result cannot match.
    const badChain: PatchChain = { ...chain, expectedSha256: "0".repeat(64) };
    const source: SourceStrategy = {
      resolveChain: vi.fn(async () => badChain),
    };
    const dest = writeTemp("out-mismatch.bin", Buffer.alloc(0));

    await expect(
      resolveAndApply({
        source,
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        oldPath: OLD,
        destPath: dest,
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("emits ordered progress events (resolve -> apply bytes -> done -> verify)", async () => {
    const output = Buffer.from("progress payload");
    const chain = makeChain(output);
    const source: SourceStrategy = { resolveChain: vi.fn(async () => chain) };
    const events: ProgressEvent[] = [];
    const dest = writeTemp("out-progress.bin", Buffer.alloc(0));

    await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      onProgress: (e) => events.push(e),
    });

    const phases = events
      .filter((e) => e.type === "phase")
      .map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(["resolve", "apply", "verify"]);

    // The apply-phase byte total must equal the output size (single hop), and
    // the final written count must reach it.
    const byteEvents = events.filter(
      (e): e is Extract<ProgressEvent, { type: "bytes" }> => e.type === "bytes",
    );
    expect(byteEvents.length).toBeGreaterThan(0);
    const last = byteEvents.at(-1);
    expect(last?.total).toBe(output.byteLength);
    expect(last?.written).toBe(output.byteLength);
  });

  it("never lets a throwing progress handler abort the apply", async () => {
    const output = Buffer.from("resilient");
    const chain = makeChain(output);
    const source: SourceStrategy = { resolveChain: vi.fn(async () => chain) };
    const dest = writeTemp("out-throwing.bin", Buffer.alloc(0));

    const result = await resolveAndApply({
      source,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      oldPath: OLD,
      destPath: dest,
      onProgress: () => {
        throw new Error("handler blew up");
      },
    });

    expect(result?.sha256).toBe(chain.expectedSha256);
    expect(new Uint8Array(await readFile(dest))).toEqual(
      new Uint8Array(output),
    );
  });
});
