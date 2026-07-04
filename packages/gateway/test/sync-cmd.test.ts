import { db, keystore, syncData } from "@loreai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the network + sync layers so cmdEnable is testable (bootstrapEncryption tests
// inject their own syncKeys and never touch these).
let mockUser: { github_login?: string } | null = { github_login: "octocat" };
let escrowRows: Array<{ id: number }> = [];
let escrowError: { message: string } | null = null;
const mockClient = {
  from: () => ({
    select: () => ({
      limit: async () => ({ data: escrowRows, error: escrowError }),
    }),
  }),
};
const pullOnceMock = vi.fn(async () => ({
  pushed: 0,
  pulled: 0,
  conflicts: 0,
}));
const syncOnceMock = vi.fn(async () => ({
  pushed: 0,
  pulled: 0,
  conflicts: 0,
}));

vi.mock("../src/supabase", () => ({
  getCurrentUser: () => Promise.resolve(mockUser),
  getAuthedClient: () => Promise.resolve(mockClient),
}));
vi.mock("../src/sync", () => ({
  pullOnce: (...a: unknown[]) => pullOnceMock(...(a as [])),
  syncOnce: (...a: unknown[]) => syncOnceMock(...(a as [])),
}));

import {
  bootstrapEncryption,
  cmdEnable,
  type EncryptionPrompts,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from "../src/cli/sync-cmd";

// Light Argon2id params for the device-1 fixtures (unlock derives with the STORED params).
const FAST = { t: 1, m: 256, p: 1 };
// A syncKeys() that positively confirmed the remote has no key (safe first-device setup).
const confirmed = () => Promise.resolve({ confirmed: true });

beforeEach(() => {
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys;",
  );
  keystore.lock();
  if (syncData.isSyncEnabled()) syncData.disableSync();
  mockUser = { github_login: "octocat" };
  escrowRows = [];
  escrowError = null;
  pullOnceMock.mockClear();
  syncOnceMock.mockClear();
});

function prompts(over: Partial<EncryptionPrompts> = {}): EncryptionPrompts {
  return {
    newPassphrase: vi.fn(async () => null),
    existingSecret: vi.fn(async () => null),
    showRecoveryCode: vi.fn(),
    log: vi.fn(),
    ...over,
  };
}

describe("bootstrapEncryption (C-4b)", () => {
  it("off + confirmed → sets a new passphrase and shows a recovery code → on", async () => {
    const p = prompts({ newPassphrase: vi.fn(async () => "hunter2") });
    const r = await bootstrapEncryption(confirmed, p);
    expect(r).toBe("on");
    expect(keystore.encryptionState()).toBe("on");
    expect(p.showRecoveryCode).toHaveBeenCalledTimes(1);
    const code = (p.showRecoveryCode as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(normalizeRecoveryCode(code)).toHaveLength(24);
  });

  it("off + UNCONFIRMED pull → aborts without minting (clobber-safe)", async () => {
    const p = prompts({ newPassphrase: vi.fn(async () => "hunter2") });
    const r = await bootstrapEncryption(
      () => Promise.resolve({ confirmed: false }),
      p,
    );
    expect(r).toBe("aborted");
    expect(keystore.encryptionState()).toBe("off"); // no key minted
    expect(p.newPassphrase).not.toHaveBeenCalled(); // never even prompted
  });

  it("off + a thrown syncKeys → treated as unconfirmed → aborts", async () => {
    const p = prompts({ newPassphrase: vi.fn(async () => "x") });
    const r = await bootstrapEncryption(() => {
      throw new Error("network down");
    }, p);
    expect(r).toBe("aborted");
    expect(keystore.encryptionState()).toBe("off");
    expect(p.newPassphrase).not.toHaveBeenCalled();
  });

  it("off + confirmed → declined passphrase → aborted, stays off", async () => {
    const r = await bootstrapEncryption(confirmed, prompts());
    expect(r).toBe("aborted");
    expect(keystore.encryptionState()).toBe("off");
  });

  it("on → no-op, never prompts", async () => {
    keystore.setPassphrase("pw", { params: FAST });
    expect(keystore.encryptionState()).toBe("on");
    const p = prompts({ newPassphrase: vi.fn(async () => "x") });
    expect(await bootstrapEncryption(confirmed, p)).toBe("on");
    expect(p.newPassphrase).not.toHaveBeenCalled();
  });

  it("locked → unlocks with the correct passphrase → on", async () => {
    keystore.setPassphrase("correct horse", { params: FAST });
    db().exec("DELETE FROM account_identity"); // fresh device
    keystore.lock();
    expect(keystore.encryptionState()).toBe("locked");

    const p = prompts({
      existingSecret: vi.fn(async () => ({
        kind: "passphrase" as const,
        value: "correct horse",
      })),
    });
    expect(await bootstrapEncryption(confirmed, p)).toBe("on");
    expect(keystore.encryptionState()).toBe("on");
  });

  it("locked → retries a wrong passphrase, then unlocks via a dashed recovery code", async () => {
    const recovery = generateRecoveryCode();
    keystore.setPassphrase("pw", { recoveryCode: recovery, params: FAST });
    db().exec("DELETE FROM account_identity");
    keystore.lock();

    // As a user might paste it: grouped with dashes and lowercased.
    const dashed = recovery.replace(/(.{4})(?=.)/g, "$1-").toLowerCase();
    const existingSecret = vi
      .fn()
      .mockResolvedValueOnce({ kind: "passphrase", value: "wrong" })
      .mockResolvedValueOnce({ kind: "recovery", value: dashed });
    expect(
      await bootstrapEncryption(confirmed, prompts({ existingSecret })),
    ).toBe("on");
    expect(existingSecret).toHaveBeenCalledTimes(2);
  });

  it("locked → aborts if the user gives up", async () => {
    keystore.setPassphrase("pw", { params: FAST });
    db().exec("DELETE FROM account_identity");
    keystore.lock();
    expect(await bootstrapEncryption(confirmed, prompts())).toBe("aborted");
  });

  it("pull-first: a pulled escrow routes to UNLOCK, not first-device setup (no clobber)", async () => {
    // Device-1 sets up escrow; capture it, then wipe local to model a fresh device.
    keystore.setPassphrase("shared-pass", { params: FAST });
    const escrow = db()
      .query("SELECT * FROM account_escrow WHERE id=1")
      .get() as Record<string, unknown>;
    db().exec("DELETE FROM account_identity; DELETE FROM account_escrow;");
    keystore.lock();
    expect(keystore.encryptionState()).toBe("off"); // nothing local yet

    // The pull brings device-1's escrow local (what a real pullOnce would apply).
    const cols = Object.keys(escrow);
    const syncKeys = async () => {
      db()
        .query(
          `INSERT INTO account_escrow (${cols.join(",")}) VALUES (${cols
            .map(() => "?")
            .join(",")})`,
        )
        .run(...cols.map((c) => escrow[c] as never));
      return { confirmed: false }; // a remote key exists; state will be "locked"
    };
    const newPassphrase = vi.fn(async () => "should-not-be-called");
    const existingSecret = vi.fn(async () => ({
      kind: "passphrase" as const,
      value: "shared-pass",
    }));

    const r = await bootstrapEncryption(
      syncKeys,
      prompts({ newPassphrase, existingSecret }),
    );
    expect(r).toBe("on");
    expect(newPassphrase).not.toHaveBeenCalled(); // took the unlock branch, not setup
    expect(existingSecret).toHaveBeenCalled();
  });
});

describe("cmdEnable (C-4b activation)", () => {
  afterEach(() => {
    process.exitCode = 0; // don't leak a failure code into the test runner
  });

  it("aborting encryption reverts a just-enabled sync and does not sync", async () => {
    expect(syncData.isSyncEnabled()).toBe(false);
    await cmdEnable(prompts({ newPassphrase: vi.fn(async () => null) }));
    expect(syncData.isSyncEnabled()).toBe(false); // reverted
    expect(syncOnceMock).not.toHaveBeenCalled(); // never synced plaintext
    expect(process.exitCode).toBe(1);
  });

  it("aborting disables even a PRE-EXISTING sync (never keeps pushing plaintext)", async () => {
    syncData.enableSync("basic"); // sync already on before this call
    expect(syncData.isSyncEnabled()).toBe(true);
    await cmdEnable(prompts({ newPassphrase: vi.fn(async () => null) }));
    expect(syncData.isSyncEnabled()).toBe(false); // disabled despite pre-existing
    expect(syncOnceMock).not.toHaveBeenCalled();
  });

  it("sets a passphrase, arms encryption, and syncs", async () => {
    await cmdEnable(prompts({ newPassphrase: vi.fn(async () => "pw") }));
    expect(syncData.isSyncEnabled()).toBe(true);
    expect(keystore.encryptionState()).toBe("on");
    expect(syncOnceMock).toHaveBeenCalledTimes(1);
  });

  it("refuses first-device setup when the escrow check is unreachable (clobber-safe)", async () => {
    escrowError = { message: "network down" }; // the confirming query fails
    const newPassphrase = vi.fn(async () => "pw");
    await cmdEnable(prompts({ newPassphrase }));
    expect(newPassphrase).not.toHaveBeenCalled(); // never prompted → never minted
    expect(keystore.encryptionState()).toBe("off");
    expect(syncData.isSyncEnabled()).toBe(false); // reverted
    expect(syncOnceMock).not.toHaveBeenCalled();
  });

  it("not logged in → errors without enabling", async () => {
    mockUser = null;
    await cmdEnable(prompts());
    expect(syncData.isSyncEnabled()).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe("recovery code", () => {
  it("generates 24 Crockford-base32 symbols", () => {
    expect(generateRecoveryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
  });

  it("normalizes dashes/spaces/case for paste tolerance", () => {
    expect(normalizeRecoveryCode("abcd-efgh 1234")).toBe("ABCDEFGH1234");
  });

  it("Crockford-remaps I/L/O → 1/1/0 for hand-transcribed codes", () => {
    expect(normalizeRecoveryCode("iLO0-1234")).toBe("11001234");
  });
});
