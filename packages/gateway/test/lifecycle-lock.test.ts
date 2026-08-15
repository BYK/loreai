import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acquireLifecycleLock,
  clearUninstallTombstoneForVerifiedInstall,
  createUninstallTombstone,
  currentUninstallTombstoneToken,
  isVerifiedPackageInvocation,
  LifecycleLockBusyError,
  LifecycleLockLostError,
  stableUnixProcessIdentity,
  withLifecycleLock,
  type LifecycleLockOptions,
  type LifecycleLockOwner,
} from "../src/lifecycle-lock";

const roots: string[] = [];

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), "lore-lifecycle-lock-"));
  roots.push(root);
  return join(root, ".lore", "lifecycle.lock");
}

function owner(
  overrides: Partial<LifecycleLockOwner> = {},
): LifecycleLockOwner {
  return {
    version: 1,
    token: "o".repeat(43),
    pid: 101,
    operation: "gateway-start",
    createdAt: "2020-01-01T00:00:00.000Z",
    processStartedAt: "2020-01-01T00:00:00.000Z",
    processIdentity: "boot:old-process",
    ...overrides,
  };
}

function writeOwner(path: string, value: LifecycleLockOwner | string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(path, "owner.json"),
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
}

function options(
  path: string,
  overrides: LifecycleLockOptions = {},
): LifecycleLockOptions {
  return {
    lockPath: path,
    pid: 202,
    processIdentity: "boot:new-process",
    processStartedAt: "2024-01-01T00:00:00.000Z",
    createToken: () => "n".repeat(43),
    ...overrides,
  };
}

function boundedClock(): Pick<
  LifecycleLockOptions,
  "now" | "sleep" | "timeoutMs" | "retryDelayMs"
> {
  let now = 1000;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    timeoutMs: 10,
    retryDelayMs: 5,
  };
}

function runLifecycleChild(
  phase:
    | "crash-initialize"
    | "crash-recovery"
    | "crash-release"
    | "acquire-release",
  path: string,
) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "lifecycle-lock-sigkill-child.ts"),
      phase,
      path,
    ],
    { encoding: "utf8", timeout: 90_000 },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("lifecycle lock generations", () => {
  test("distinguishes same-second Unix PID generations using stable start ticks", () => {
    const secondResolutionStartedAt = "Fri Aug 14 11:22:33 2026";
    const predecessor = stableUnixProcessIdentity({
      bootId: "boot-generation",
      startTicks: "10001",
      secondResolutionStartedAt,
    });
    const successor = stableUnixProcessIdentity({
      bootId: "boot-generation",
      startTicks: "10002",
      secondResolutionStartedAt,
    });

    expect(predecessor).toBe("unix-procfs:boot-generation:10001");
    expect(successor).toBe("unix-procfs:boot-generation:10002");
    expect(successor).not.toBe(predecessor);
  });

  test("rejects lstart-only Unix identity metadata", () => {
    expect(
      stableUnixProcessIdentity({
        secondResolutionStartedAt: "Fri Aug 14 11:22:33 2026",
      }),
    ).toBeNull();
    expect(
      stableUnixProcessIdentity({
        bootId: "boot-generation",
        secondResolutionStartedAt: "Fri Aug 14 11:22:33 2026",
      }),
    ).toBeNull();
  });

  test("publishes an owner-only generation record and releases only itself", async () => {
    const path = lockPath();
    const lock = await acquireLifecycleLock(
      "upgrade",
      options(path, { now: () => Date.parse("2024-02-03T04:05:06.000Z") }),
    );
    expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf8"))).toEqual({
      version: 1,
      token: "n".repeat(43),
      pid: 202,
      operation: "upgrade",
      createdAt: "2024-02-03T04:05:06.000Z",
      processStartedAt: "2024-01-01T00:00:00.000Z",
      processIdentity: "boot:new-process",
    });
    if (process.platform !== "win32") {
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(path, "owner.json")).mode & 0o777).toBe(0o600);
    }
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "recovers in a fresh process after SIGKILL between directory creation and owner publication",
    () => {
      const path = lockPath();
      const killed = runLifecycleChild("crash-initialize", path);
      expect(killed.error).toBeUndefined();
      expect(killed.status, killed.stderr).toBeNull();
      expect(killed.signal).toBe("SIGKILL");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(path, "owner.json"))).toBe(false);
      expect(
        readdirSync(dirname(path)).filter((entry) =>
          entry.startsWith(".lifecycle.lock.init."),
        ),
      ).toHaveLength(1);

      const recovered = runLifecycleChild("acquire-release", path);
      expect(recovered.error).toBeUndefined();
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(existsSync(path)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "recovers in a fresh process after SIGKILL between owner removal and directory removal",
    () => {
      const path = lockPath();
      const killed = runLifecycleChild("crash-release", path);
      expect(killed.error).toBeUndefined();
      expect(killed.status, killed.stderr).toBeNull();
      expect(killed.signal).toBe("SIGKILL");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(path, "owner.json"))).toBe(false);
      expect(
        readdirSync(dirname(path)).some((entry) =>
          entry.startsWith(".lifecycle.lock.release."),
        ),
      ).toBe(true);

      const recovered = runLifecycleChild("acquire-release", path);
      expect(recovered.error).toBeUndefined();
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(existsSync(path)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a second SIGKILL during incomplete-generation recovery remains recoverable",
    () => {
      const path = lockPath();
      expect(runLifecycleChild("crash-initialize", path).signal).toBe(
        "SIGKILL",
      );
      const killedRecovery = runLifecycleChild("crash-recovery", path);
      expect(killedRecovery.error).toBeUndefined();
      expect(killedRecovery.status, killedRecovery.stderr).toBeNull();
      expect(killedRecovery.signal).toBe("SIGKILL");
      expect(existsSync(join(path, "owner.json"))).toBe(false);

      const recovered = runLifecycleChild("acquire-release", path);
      expect(recovered.error).toBeUndefined();
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(existsSync(path)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not apply a delayed release claim to a replacement directory",
    async () => {
      const path = lockPath();
      expect(runLifecycleChild("crash-release", path).signal).toBe("SIGKILL");
      renameSync(path, `${path}.predecessor`);
      mkdirSync(path, { mode: 0o700 });

      await expect(
        acquireLifecycleLock("upgrade", options(path, boundedClock())),
      ).rejects.toBeInstanceOf(LifecycleLockBusyError);
      expect(readdirSync(path)).toEqual([]);
    },
  );

  test("recovers only an empty directory backed by a dead initialization generation", async () => {
    const ambiguous = lockPath();
    mkdirSync(ambiguous, { recursive: true, mode: 0o700 });
    await expect(
      acquireLifecycleLock("upgrade", options(ambiguous, boundedClock())),
    ).rejects.toBeInstanceOf(LifecycleLockBusyError);

    const recoverable = lockPath();
    mkdirSync(recoverable, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dirname(recoverable), `.lifecycle.lock.init.${owner().token}`),
      `${JSON.stringify(owner())}\n`,
      { mode: 0o600 },
    );
    const lock = await acquireLifecycleLock(
      "upgrade",
      options(recoverable, { inspectProcess: () => ({ state: "dead" }) }),
    );
    expect(lock.owner.token).toBe("n".repeat(43));
    lock.release();
  });

  test("does not steal the empty directory of a live initializer", async () => {
    const path = lockPath();
    let contender!: Promise<unknown>;
    const initializer = acquireLifecycleLock(
      "upgrade",
      options(path, {
        pid: 101,
        processIdentity: "boot:initializer",
        createToken: () => "i".repeat(43),
        _afterLockDirectoryCreated: () => {
          contender = acquireLifecycleLock(
            "setup",
            options(path, {
              ...boundedClock(),
              pid: 303,
              processIdentity: "boot:contender",
              createToken: () => "c".repeat(43),
              inspectProcess: (pid) =>
                pid === 101
                  ? { state: "alive", identity: "boot:initializer" }
                  : { state: "alive", identity: "boot:contender" },
            }),
          );
        },
      }),
    );

    const lock = await initializer;
    await expect(contender).rejects.toBeInstanceOf(LifecycleLockBusyError);
    expect(lock.owner.token).toBe("i".repeat(43));
    lock.release();
  });

  test("a releaser cannot remove a successor published in its cleanup window", async () => {
    const path = lockPath();
    let successor!: Promise<Awaited<ReturnType<typeof acquireLifecycleLock>>>;
    const predecessor = await acquireLifecycleLock(
      "upgrade",
      options(path, {
        createToken: () => "p".repeat(43),
        _afterLockOwnerRemoved: () => {
          successor = acquireLifecycleLock(
            "setup",
            options(path, {
              pid: 303,
              processIdentity: "boot:successor",
              createToken: () => "s".repeat(43),
            }),
          );
        },
      }),
    );

    predecessor.release();
    const successorLock = await successor;
    expect(
      JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token,
    ).toBe(successorLock.owner.token);
    successorLock.release();
  });

  test("bounds contention without stealing an old live owner", async () => {
    const path = lockPath();
    writeOwner(path, owner());
    await expect(
      acquireLifecycleLock(
        "upgrade",
        options(path, {
          ...boundedClock(),
          inspectProcess: () => ({
            state: "alive",
            identity: "boot:old-process",
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(LifecycleLockBusyError);
    expect(
      JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token,
    ).toBe("o".repeat(43));
  });

  test("reclaims dead and PID-reused owners without predecessor deletion", async () => {
    const path = lockPath();
    const predecessor = await acquireLifecycleLock(
      "gateway-start",
      options(path, {
        pid: 101,
        processIdentity: "boot:old-process",
        createToken: () => "o".repeat(43),
      }),
    );
    const successor = await acquireLifecycleLock(
      "gateway-shutdown",
      options(path, {
        pid: 101,
        inspectProcess: () => ({
          state: "alive",
          identity: "boot:reused-process",
        }),
      }),
    );
    expect(() => predecessor.release()).toThrow(LifecycleLockLostError);
    expect(
      JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token,
    ).toBe(successor.owner.token);
    successor.release();
  });

  test("a delayed stale reclaimer cannot move a published successor", async () => {
    const path = lockPath();
    const stale = owner();
    writeOwner(path, stale);
    const claim = join(dirname(path), `.lifecycle.lock.claim.${stale.token}`);
    renameSync(path, claim);
    const successor = await acquireLifecycleLock("upgrade", options(path));
    expect(() => renameSync(path, claim)).toThrow();
    expect(
      JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token,
    ).toBe(successor.owner.token);
    successor.release();
  });

  test("does not replace an attacker-created empty stale-claim path", async () => {
    const path = lockPath();
    const stale = owner();
    writeOwner(path, stale);
    const claim = join(dirname(path), `.lifecycle.lock.claim.${stale.token}`);
    mkdirSync(claim, { mode: 0o700 });

    await expect(
      acquireLifecycleLock(
        "upgrade",
        options(path, {
          ...boundedClock(),
          inspectProcess: () => ({ state: "dead" }),
        }),
      ),
    ).rejects.toBeInstanceOf(LifecycleLockBusyError);
    expect(
      JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token,
    ).toBe(stale.token);
    expect(readdirSync(claim)).toEqual([]);
  });

  test("keeps malformed, loose-mode, and symlink locks conservatively busy", async () => {
    const malformed = lockPath();
    writeOwner(malformed, "not json");
    await expect(
      acquireLifecycleLock("uninstall", options(malformed, boundedClock())),
    ).rejects.toBeInstanceOf(LifecycleLockBusyError);

    const malformedClaim = lockPath();
    mkdirSync(malformedClaim, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dirname(malformedClaim), `.lifecycle.lock.init.${"x".repeat(43)}`),
      "not json",
      { mode: 0o600 },
    );
    await expect(
      acquireLifecycleLock(
        "uninstall",
        options(malformedClaim, boundedClock()),
      ),
    ).rejects.toBeInstanceOf(LifecycleLockBusyError);

    if (process.platform !== "win32") {
      const looseEmpty = lockPath();
      mkdirSync(looseEmpty, { recursive: true, mode: 0o755 });
      await expect(
        acquireLifecycleLock("setup", options(looseEmpty, boundedClock())),
      ).rejects.toBeInstanceOf(LifecycleLockBusyError);

      const loose = lockPath();
      writeOwner(loose, owner());
      chmodSync(join(loose, "owner.json"), 0o644);
      await expect(
        acquireLifecycleLock("setup", options(loose, boundedClock())),
      ).rejects.toBeInstanceOf(LifecycleLockBusyError);

      const link = lockPath();
      const target = join(dirname(link), "target");
      mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, "sentinel"), "preserve", { mode: 0o600 });
      symlinkSync(target, link);
      await expect(
        acquireLifecycleLock("upgrade", options(link, boundedClock())),
      ).rejects.toBeInstanceOf(LifecycleLockBusyError);
      expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("preserve");
    }
  });

  test("is reentrant within one async lifecycle transition", async () => {
    const path = lockPath();
    const tokens: string[] = [];
    await withLifecycleLock(
      "setup",
      async (outer) => {
        tokens.push(outer.owner.token);
        await withLifecycleLock("hosted-install", (inner) => {
          tokens.push(inner.owner.token);
        });
      },
      options(path),
    );
    expect(tokens).toEqual(["n".repeat(43), "n".repeat(43)]);
  });
});

describe("uninstall tombstone generations", () => {
  test("rejects a start queued before uninstall publishes its tombstone", async () => {
    const path = lockPath();
    let release!: () => void;
    let held!: () => void;
    const heldPromise = new Promise<void>((resolve) => (held = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const uninstall = withLifecycleLock(
      "uninstall",
      async (lock) => {
        held();
        await gate;
        createUninstallTombstone(lock);
      },
      options(path, {
        timeoutMs: 1000,
        inspectProcess: () => ({
          state: "alive",
          identity: "boot:new-process",
        }),
      }),
    );
    await heldPromise;
    const queued = withLifecycleLock(
      "gateway-start",
      () => "resurrected",
      options(path, {
        timeoutMs: 1000,
        retryDelayMs: 1,
        inspectProcess: () => ({
          state: "alive",
          identity: "boot:new-process",
        }),
      }),
    );
    const rejection = expect(queued).rejects.toThrow(/stale gateway-start/);
    release();
    await uninstall;
    await rejection;
  });

  test("requires verified generation evidence before clearing a tombstone", async () => {
    const path = lockPath();
    await withLifecycleLock(
      "uninstall",
      (lock) => createUninstallTombstone(lock),
      options(path),
    );
    await expect(
      withLifecycleLock(
        "gateway-start",
        () => "started",
        options(path, { seaBinary: true }),
      ),
    ).rejects.toThrow(/Lore is uninstalled/);

    await expect(
      withLifecycleLock(
        "hosted-install",
        (lock) => {
          const token = currentUninstallTombstoneToken(lock);
          if (!token) throw new Error("missing tombstone");
          clearUninstallTombstoneForVerifiedInstall(lock, token, () => false);
        },
        options(path),
      ),
    ).rejects.toThrow(/binary\/receipt verification/);

    await withLifecycleLock(
      "hosted-install",
      (lock) => {
        const token = currentUninstallTombstoneToken(lock);
        if (!token) throw new Error("missing tombstone");
        clearUninstallTombstoneForVerifiedInstall(lock, token, () => true);
      },
      options(path),
    );
    await expect(
      withLifecycleLock("gateway-start", () => "started", options(path)),
    ).resolves.toBe("started");
  });

  test("recognizes only the declared installed package CLI", () => {
    const path = lockPath();
    const packageRoot = join(
      dirname(dirname(path)),
      "node_modules",
      "@loreai",
      "gateway",
    );
    const entry = join(packageRoot, "dist", "bin.cjs");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "#!/usr/bin/env node\n");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@loreai/gateway",
        bin: { lore: "./dist/bin.cjs" },
      }),
    );
    expect(
      isVerifiedPackageInvocation({ entryPath: entry, seaBinary: false }),
    ).toBe(true);
    expect(
      isVerifiedPackageInvocation({ entryPath: entry, seaBinary: true }),
    ).toBe(false);
  });
});
