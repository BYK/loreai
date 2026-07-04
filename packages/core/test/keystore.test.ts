import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { keystore, syncData } from "../src/index";

// Light Argon2id params — escrow correctness is independent of the work factor.
const FAST = { t: 1, m: 256, p: 1 };
const eq = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));

beforeEach(() => {
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys;",
  );
  keystore.lock(); // clear process-lifetime caches between tests
});

/** Simulate a fresh device that has pulled escrow + scope_keys but has no local identity. */
function simulateFreshDevice(): void {
  db().exec("DELETE FROM account_identity");
  keystore.lock();
}

describe("keystore — account identity", () => {
  it("creates the identity on first use and persists it", () => {
    expect(keystore.hasAccountIdentity()).toBe(false);
    const id = keystore.getAccountIdentity();
    expect(id.publicKey.length).toBe(32);
    expect(id.secretKey.length).toBe(32);
    expect(keystore.hasAccountIdentity()).toBe(true);
    const rows = db()
      .query("SELECT COUNT(*) AS n FROM account_identity")
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("is stable across calls and across a cache reload from the db", () => {
    const a = keystore.getAccountIdentity();
    const b = keystore.getAccountIdentity();
    expect(eq(a.secretKey, b.secretKey)).toBe(true);
    keystore.lock(); // force reload from db
    const c = keystore.getAccountIdentity();
    expect(eq(a.secretKey, c.secretKey)).toBe(true);
    expect(eq(a.publicKey, c.publicKey)).toBe(true);
  });
});

describe("keystore — scope DEKs", () => {
  it("generates a DEK on first use and returns the same DEK afterwards", async () => {
    const dek1 = await keystore.getScopeKey("user-1");
    expect(dek1.length).toBe(32);
    const dek2 = await keystore.getScopeKey("user-1");
    expect(eq(dek1, dek2)).toBe(true);
  });

  it("re-unwraps the same DEK after a lock() (no plaintext DEK persisted)", async () => {
    const dek1 = await keystore.getScopeKey("user-1");
    keystore.lock();
    const dek2 = await keystore.getScopeKey("user-1");
    expect(eq(dek1, dek2)).toBe(true);
    // the stored row is a wrapped blob, NOT the plaintext DEK
    const row = db()
      .query(
        "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id = 'user-1'",
      )
      .get() as { w: Uint8Array };
    const wrapped = new Uint8Array(row.w);
    expect(Buffer.from(wrapped).includes(Buffer.from(dek1))).toBe(false);
  });

  it("derives distinct DEKs for distinct scopes", async () => {
    const a = await keystore.getScopeKey("scope-a");
    const b = await keystore.getScopeKey("scope-b");
    expect(eq(a, b)).toBe(false);
  });

  it("concurrent first-use calls for one scope converge on a single DEK (no clobber)", async () => {
    keystore.getAccountIdentity();
    const [a, b, c] = await Promise.all([
      keystore.getScopeKey("racy"),
      keystore.getScopeKey("racy"),
      keystore.getScopeKey("racy"),
    ]);
    expect(eq(a, b)).toBe(true);
    expect(eq(a, c)).toBe(true);
    // exactly one row persisted, and it unwraps to the returned DEK
    const n = db()
      .query("SELECT COUNT(*) AS n FROM scope_keys WHERE scope_id = 'racy'")
      .get() as { n: number };
    expect(n.n).toBe(1);
    keystore.lock();
    expect(eq(await keystore.getScopeKey("racy"), a)).toBe(true);
  });

  it("an in-flight getScopeKey resolving after lock() does NOT repopulate the cache", async () => {
    keystore.getAccountIdentity();
    const p = keystore.getScopeKey("s"); // in-flight (awaiting HPKE wrap/unwrap)
    keystore.lock(); // clears cache + bumps epoch mid-flight
    const first = await p; // resolves — must NOT write into dekCache
    // Remove the persisted row: if the stale in-flight result had repopulated the
    // cache, the next call would return it; with the epoch guard the cache is empty,
    // so a fresh DEK is generated (distinct from the stale one).
    db().exec("DELETE FROM scope_keys WHERE scope_id = 's'");
    const after = await keystore.getScopeKey("s");
    expect(eq(first, after)).toBe(false);
  });

  it("putWrappedScopeKey applies an external wrapped DEK and invalidates the cache", async () => {
    // device-1 makes a DEK for a scope
    const dek = await keystore.getScopeKey("shared");
    const wrapped = new Uint8Array(
      (
        db()
          .query(
            "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id = 'shared'",
          )
          .get() as { w: Uint8Array }
      ).w,
    );
    // wipe the row + cache, then re-apply via putWrappedScopeKey (the C-3 pull path)
    db().exec("DELETE FROM scope_keys");
    keystore.lock();
    keystore.putWrappedScopeKey("shared", "shared", wrapped, 0, Date.now());
    const dek2 = await keystore.getScopeKey("shared");
    expect(eq(dek, dek2)).toBe(true);
  });
});

describe("keystore — escrow (passphrase set / unlock)", () => {
  it("sets an escrow record", () => {
    keystore.getAccountIdentity();
    expect(keystore.hasEscrow()).toBe(false);
    keystore.setPassphrase("correct horse", { params: FAST });
    expect(keystore.hasEscrow()).toBe(true);
  });

  it("a fresh device recovers the SAME identity + DEK via the passphrase", async () => {
    // device-1: identity + a scope DEK + passphrase
    const id1 = keystore.getAccountIdentity();
    const dek1 = await keystore.getScopeKey("user-1");
    keystore.setPassphrase("hunter2", { params: FAST });

    // device-2: fresh (no local identity), but escrow + scope_keys were synced
    simulateFreshDevice();
    expect(keystore.hasAccountIdentity()).toBe(false);
    expect(keystore.unlockWithPassphrase("hunter2")).toBe(true);

    const id2 = keystore.getAccountIdentity();
    expect(eq(id1.secretKey, id2.secretKey)).toBe(true);
    const dek2 = await keystore.getScopeKey("user-1");
    expect(eq(dek1, dek2)).toBe(true);
  });

  it("rejects a wrong passphrase and does not install an identity", () => {
    keystore.getAccountIdentity();
    keystore.setPassphrase("right", { params: FAST });
    simulateFreshDevice();
    expect(keystore.unlockWithPassphrase("WRONG")).toBe(false);
    expect(keystore.hasAccountIdentity()).toBe(false); // still locked
  });

  it("a fresh device with escrow but no identity is LOCKED (never mints a new key)", async () => {
    keystore.getAccountIdentity();
    keystore.setPassphrase("pw", { params: FAST });
    simulateFreshDevice();
    expect(() => keystore.getAccountIdentity()).toThrow(
      keystore.KeystoreLockedError,
    );
    await expect(keystore.getScopeKey("user-1")).rejects.toThrow(
      keystore.KeystoreLockedError,
    );
  });

  it("changing the passphrase invalidates the old one", () => {
    keystore.getAccountIdentity();
    keystore.setPassphrase("old", { params: FAST });
    keystore.setPassphrase("new", { params: FAST }); // re-wrap the loaded identity
    simulateFreshDevice();
    expect(keystore.unlockWithPassphrase("old")).toBe(false);
    expect(keystore.unlockWithPassphrase("new")).toBe(true);
  });

  it("supports an independent recovery-code unlock path", () => {
    const id1 = keystore.getAccountIdentity();
    keystore.setPassphrase("primary", {
      recoveryCode: "RECOVERY-CODE-XYZ",
      params: FAST,
    });
    simulateFreshDevice();
    expect(keystore.unlockWithRecoveryCode("nope")).toBe(false);
    expect(keystore.unlockWithRecoveryCode("RECOVERY-CODE-XYZ")).toBe(true);
    expect(eq(keystore.getAccountIdentity().secretKey, id1.secretKey)).toBe(
      true,
    );
  });

  it("unlockWithRecoveryCode returns false when no recovery code was configured", () => {
    keystore.getAccountIdentity();
    keystore.setPassphrase("primary", { params: FAST }); // no recovery code
    simulateFreshDevice();
    expect(keystore.unlockWithRecoveryCode("anything")).toBe(false);
  });

  it("unlockWithPassphrase throws when there is no escrow record", () => {
    expect(() => keystore.unlockWithPassphrase("x")).toThrow(/no escrow/);
  });

  it("setPassphrase on a LOCKED fresh device throws (never overwrites escrow with a new key)", () => {
    keystore.getAccountIdentity();
    keystore.setPassphrase("pw", { params: FAST });
    simulateFreshDevice();
    expect(() => keystore.setPassphrase("attacker", { params: FAST })).toThrow(
      keystore.KeystoreLockedError,
    );
  });

  it("changing the passphrase PRESERVES a previously-set recovery code", () => {
    keystore.getAccountIdentity();
    keystore.setPassphrase("old", { recoveryCode: "REC-CODE", params: FAST });
    keystore.setPassphrase("new", { params: FAST }); // no recovery code supplied
    simulateFreshDevice();
    // both the new passphrase AND the original recovery code still unlock
    expect(keystore.unlockWithRecoveryCode("REC-CODE")).toBe(true);
    simulateFreshDevice();
    expect(keystore.unlockWithPassphrase("new")).toBe(true);
  });

  it("a preserved recovery code survives a passphrase change under DIFFERENT kdf params", () => {
    // recovery carries its own kdf params, so changing the passphrase's params must
    // not invalidate the preserved recovery wrapping.
    keystore.getAccountIdentity();
    keystore.setPassphrase("old", {
      recoveryCode: "REC",
      params: { t: 1, m: 256, p: 1 },
    });
    keystore.setPassphrase("new", { params: { t: 2, m: 512, p: 1 } }); // different params, no code
    simulateFreshDevice();
    expect(keystore.unlockWithRecoveryCode("REC")).toBe(true);
  });
});

describe("keystore — local-only invariant", () => {
  it("account_identity (plaintext secret) is NEVER a synced table", () => {
    const synced = [
      ...syncData.SYNCED_TABLES.basic,
      ...syncData.SYNCED_TABLES.pro,
    ].map((t) => t.table);
    // The account identity secret must never leave the device. scope_keys /
    // account_escrow are ciphertext and DO become synced in C-3.
    expect(synced).not.toContain("account_identity");
  });
});
