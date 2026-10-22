import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCache, resolveAndApply, type PatchChain } from "binpatch";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// Real TRDIFF10 delta: every output byte depends on the corresponding base byte.
function delta(old: string, next: string): Uint8Array {
  const control = Buffer.alloc(24);
  control.writeBigUInt64LE(BigInt(next.length));
  const c = zstdCompressSync(control);
  const d = zstdCompressSync(
    Buffer.from(
      [...Buffer.from(next)].map((b, i) => (b - old.charCodeAt(i) + 256) % 256),
    ),
  );
  const header = Buffer.alloc(32);
  header.write("TRDIFF10");
  header.writeBigUInt64LE(BigInt(c.length), 8);
  header.writeBigUInt64LE(BigInt(d.length), 16);
  header.writeBigUInt64LE(BigInt(next.length), 24);
  return Buffer.concat([header, c, d, zstdCompressSync(Buffer.alloc(0))]);
}
function fixture(sourceSha256: string | undefined = sha("old")) {
  const root = mkdtempSync(join(tmpdir(), "lore-delta-source-"));
  roots.push(root);
  const oldPath = join(root, "old");
  const destPath = join(root, "new");
  writeFileSync(oldPath, "old");
  writeFileSync(destPath, "untouched");
  const data = delta("old", "new");
  const chain: PatchChain & { sourceSha256?: string } = {
    patches: [{ data, size: data.length }],
    totalSize: data.length,
    expectedSha256: sha("new"),
    sourceSha256,
    steps: [{ fromVersion: "1.0.0", toVersion: "1.1.0" }],
  };
  return { root, chain, oldPath, destPath };
}

describe("delta base identity", () => {
  it.each(["network", "cache", "offline"])(
    "skips a rebuilt binary with the same version via %s without touching the destination",
    async (mode) => {
      const f = fixture();
      const cache = makeCache(join(f.root, "cache"));
      if (mode !== "network") await cache.save(f.chain, f.chain.steps!);
      writeFileSync(f.oldPath, "bad"); // state changes AFTER the official patch was cached
      const source = { resolveChain: vi.fn(async () => f.chain) };
      const unavailable = vi.fn();
      await expect(
        resolveAndApply({
          source,
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          ...f,
          cache,
          offline: mode === "offline",
          telemetry: { onUnavailable: unavailable },
        }),
      ).resolves.toBeNull();
      expect(readFileSync(f.destPath, "utf8")).toBe("untouched");
      expect(unavailable).toHaveBeenCalledWith("source_mismatch");
      if (mode !== "network")
        expect(source.resolveChain).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "invalid", "short"])(
    "skips %s source checksums",
    async (kind) => {
      const f = fixture();
      f.chain.sourceSha256 =
        kind === "missing"
          ? undefined
          : kind === "invalid"
            ? "g".repeat(64)
            : "abc";
      const unavailable = vi.fn();
      await expect(
        resolveAndApply({
          source: { resolveChain: async () => f.chain },
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          ...f,
          telemetry: { onUnavailable: unavailable },
        }),
      ).resolves.toBeNull();
      expect(readFileSync(f.destPath, "utf8")).toBe("untouched");
      expect(unavailable).toHaveBeenCalledWith("source_unverified");
    },
  );
  it("round-trips source identity in the cache and applies a matching real delta offline", async () => {
    const f = fixture();
    const cache = makeCache(join(f.root, "cache"));
    await cache.save(f.chain, f.chain.steps!);
    expect(await cache.load("1.0.0", "1.1.0")).toMatchObject({
      sourceSha256: sha("old"),
    });
    const result = await resolveAndApply({
      source: {
        resolveChain: async () => {
          throw Error("offline used network");
        },
      },
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      ...f,
      cache,
      offline: true,
    });
    expect(result?.sha256).toBe(sha("new"));
    expect(readFileSync(f.destPath, "utf8")).toBe("new");
  });
  it("still rejects a corrupt target after a matching source", async () => {
    const f = fixture();
    f.chain.expectedSha256 = sha("wrong");
    await expect(
      resolveAndApply({
        source: { resolveChain: async () => f.chain },
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        ...f,
      }),
    ).rejects.toThrow("SHA-256 mismatch after patching");
  });
});

it.skipIf(process.platform === "win32")(
  "validates the in-memory fallback when the snapshot directory cannot be created",
  async () => {
    const f = fixture();
    vi.stubEnv("TMPDIR", join(f.root, "nonexistent"));
    try {
      const options = {
        source: { resolveChain: async () => f.chain },
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        ...f,
      };
      expect((await resolveAndApply(options))?.sha256).toBe(sha("new"));
      writeFileSync(f.destPath, "untouched");
      writeFileSync(f.oldPath, "bad");
      expect(await resolveAndApply(options)).toBeNull();
      expect(readFileSync(f.destPath, "utf8")).toBe("untouched");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "does not follow a planted predictable snapshot symlink",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const f = fixture();
    const script = `
    import { resolveAndApply } from "binpatch";
    import { writeFileSync, readFileSync, symlinkSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    const [root, patch, sourceSha256, expectedSha256] = process.argv.slice(1);
    const victim = join(root, "victim");
    writeFileSync(victim, "keep this file");
    symlinkSync(victim, join(root, "binpatch-old-" + process.pid + "-1"));
    const data = Buffer.from(patch, "base64");
    const chain = { patches: [{data,size:data.length}], totalSize:data.length, sourceSha256, expectedSha256 };
    const result = await resolveAndApply({source:{resolveChain:async()=>chain}, currentVersion:"1.0.0", targetVersion:"1.1.0", oldPath:join(root,"old"),destPath:join(root,"new")});
    console.log(JSON.stringify({ sha256:result?.sha256, victim:readFileSync(victim,"utf8"), snapshots:readdirSync(root).filter(n=>n.startsWith("binpatch-old-") && !n.endsWith("-1")) }));
  `;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        script,
        f.root,
        Buffer.from(f.chain.patches[0].data).toString("base64"),
        sha("old"),
        sha("new"),
      ],
      {
        cwd: join(__dirname, "../../.."),
        env: { ...process.env, TMPDIR: f.root },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toEqual({
      sha256: sha("new"),
      victim: "keep this file",
      snapshots: [],
    });
  },
);

it("composes separately cached compatible deltas offline and rejects incompatible boundaries", async () => {
  const f = fixture();
  const cache = makeCache(join(f.root, "cache"));
  const firstData = delta("old", "mid");
  const lastData = delta("mid", "new");
  const first = {
    patches: [{ data: firstData, size: firstData.length }],
    sourceSha256: sha("old"),
    expectedSha256: sha("mid"),
  };
  const second = {
    patches: [{ data: lastData, size: lastData.length }],
    sourceSha256: sha("mid"),
    expectedSha256: sha("new"),
  };
  await cache.save(first, [{ fromVersion: "1.0.0", toVersion: "1.0.1" }]);
  await cache.save(second, [{ fromVersion: "1.0.1", toVersion: "1.1.0" }]);
  const options = {
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    ...f,
    cache,
    offline: true,
    source: {
      resolveChain: async () => {
        throw Error("offline network access");
      },
    },
  };
  expect((await resolveAndApply(options))?.sha256).toBe(sha("new"));
  expect(readFileSync(f.destPath, "utf8")).toBe("new");
  // Replace the second edge with a different build of the same version.
  await cache.save({ ...second, sourceSha256: sha("different middle") }, [
    { fromVersion: "1.0.1", toVersion: "1.1.0" },
  ]);
  writeFileSync(f.destPath, "untouched");
  expect(await resolveAndApply(options)).toBeNull();
  expect(readFileSync(f.destPath, "utf8")).toBe("untouched");
});

it("can use a verified suffix of a prefetched multi-hop chain offline", async () => {
  const f = fixture();
  const cache = makeCache(join(f.root, "cache"));
  const first = delta("old", "mid");
  const second = delta("mid", "new");
  const chain = {
    ...f.chain,
    patches: [
      { data: first, size: first.length },
      { data: second, size: second.length },
    ],
    steps: [
      {
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        sourceSha256: sha("old"),
        targetSha256: sha("mid"),
      },
      {
        fromVersion: "1.0.1",
        toVersion: "1.1.0",
        sourceSha256: sha("mid"),
        targetSha256: sha("new"),
      },
    ],
  };
  await cache.save(chain, chain.steps);
  writeFileSync(f.oldPath, "mid");
  expect(
    (
      await resolveAndApply({
        currentVersion: "1.0.1",
        targetVersion: "1.1.0",
        ...f,
        cache,
        offline: true,
        source: {
          resolveChain: async () => {
            throw Error("offline network access");
          },
        },
      })
    )?.sha256,
  ).toBe(sha("new"));
});

it.skipIf(process.platform === "win32")(
  "uses memory when any temporary directory ancestor has permissive permissions",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, chmodSync } = await import("node:fs");
    const f = fixture();
    const shared = join(f.root, "shared");
    const child = join(shared, "private-child");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    mkdirSync(child, { mode: 0o700 });
    const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const original = fs.copyFileSync;
    let copies = 0;
    fs.copyFileSync = (...args) => { copies++; return original(...args); };
    syncBuiltinESMExports();
    const { resolveAndApply } = await import("binpatch");
    const [root, patch, sourceSha256, expectedSha256] = process.argv.slice(1);
    const data = Buffer.from(patch, "base64");
    const chain = { patches:[{data,size:data.length}],totalSize:data.length,sourceSha256,expectedSha256 };
    const result = await resolveAndApply({source:{resolveChain:async()=>chain},currentVersion:"1.0.0",targetVersion:"1.1.0",oldPath:join(root,"old"),destPath:join(root,"new")});
    console.log(JSON.stringify({sha256:result?.sha256,copies}));
  `;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        script,
        f.root,
        Buffer.from(f.chain.patches[0].data).toString("base64"),
        sha("old"),
        sha("new"),
      ],
      {
        cwd: join(__dirname, "../../.."),
        env: { ...process.env, TMPDIR: child },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toEqual({ sha256: sha("new"), copies: 0 });
  },
);
