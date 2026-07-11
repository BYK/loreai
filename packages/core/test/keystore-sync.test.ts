import { beforeEach, describe, expect, it } from "vitest";
import { db, setTeamConfig } from "../src/db";
import { keystore, syncData } from "../src/index";

// Light Argon2id params — escrow correctness is independent of the work factor.
const FAST = { t: 1, m: 256, p: 1 };
const eq = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));
const SCOPE = "11111111-1111-4111-8111-111111111111";

function clearKeystore(): void {
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys;",
  );
  db().exec("DELETE FROM sync_outbox; DELETE FROM sync_state");
  keystore.lock();
}

/** Base64-encode a local row's blobColumns into a wire row, adding the server scope_id. */
function toWire(
  table: string,
  local: Record<string, unknown>,
  scopeId: string,
): Record<string, unknown> {
  const blobs =
    syncData.syncedTables().find((m) => m.table === table)?.blobColumns ?? [];
  const out: Record<string, unknown> = { ...local, scope_id: scopeId };
  for (const c of blobs) {
    const v = out[c];
    if (v instanceof Uint8Array) out[c] = Buffer.from(v).toString("base64");
  }
  return out;
}

beforeEach(() => {
  clearKeystore();
  setTeamConfig("sync.enabled", "1"); // capture triggers active
});

describe("C-4 keystore.encryptionState", () => {
  it("is 'off' with no escrow (encryption never set up)", () => {
    expect(keystore.encryptionState()).toBe("off");
  });

  it("is 'on' on the original device (escrow + local identity)", () => {
    keystore.setPassphrase("pw", { params: FAST });
    expect(keystore.hasEscrow()).toBe(true);
    expect(keystore.hasAccountIdentity()).toBe(true);
    expect(keystore.encryptionState()).toBe("on");
  });

  it("is 'locked' on a fresh device (escrow pulled, identity not installed)", () => {
    keystore.setPassphrase("pw", { params: FAST });
    // simulate a fresh device: escrow present (pulled via C-3), identity absent
    db().exec("DELETE FROM account_identity");
    keystore.lock();
    expect(keystore.hasEscrow()).toBe(true);
    expect(keystore.hasAccountIdentity()).toBe(false);
    expect(keystore.encryptionState()).toBe("locked");
    // unlocking installs the identity → "on"
    expect(keystore.unlockWithPassphrase("pw")).toBe(true);
    expect(keystore.encryptionState()).toBe("on");
  });
});

describe("C-3 registry — encryption key-store tables", () => {
  it("account_escrow and scope_keys are registered, non-pull-only, blobColumns ⊆ syncColumns", () => {
    for (const table of ["account_escrow", "scope_keys"]) {
      const m = syncData.syncedTables().find((x) => x.table === table);
      expect(m, `${table} registered`).toBeDefined();
      expect(m?.pullOnly ?? false).toBe(false);
      for (const b of m?.blobColumns ?? []) {
        expect(m?.syncColumns).toContain(b);
      }
    }
  });

  it("a local key write enqueues an outbox entry keyed correctly", async () => {
    keystore.setPassphrase("pw", { params: FAST });
    await keystore.getScopeKey(SCOPE, SCOPE);
    const escrow = syncData
      .readOutbox(0)
      .filter((e) => e.table_name === "account_escrow");
    const sk = syncData
      .readOutbox(0)
      .filter((e) => e.table_name === "scope_keys");
    expect(escrow.length).toBeGreaterThan(0);
    expect(escrow[0].row_id).toBe("1"); // single-row id
    expect(sk.length).toBeGreaterThan(0);
    expect(sk[0].row_id).toBe(`${SCOPE}\x1f0`); // composite: member_user_id ⟳ key_epoch (E-4c-3)
  });

  it("the captured scope_keys outbox row_id resolves back to its row (trigger ⇄ idColumns order)", async () => {
    keystore.setPassphrase("pw", { params: FAST });
    await keystore.getScopeKey(SCOPE, SCOPE); // captures a scope_keys row
    const sk = syncData
      .readOutbox(0)
      .filter((e) => e.table_name === "scope_keys");
    expect(sk.length).toBeGreaterThan(0);
    // The trigger-produced row_id MUST decompose (via idColumns) back to the real row. An
    // idColumns-order regression vs the capture trigger would return null here — catching the
    // silent-corruption vector in the fast unit suite, not only the Docker round-trip (E-4c-3a).
    const row = syncData.getRowById("scope_keys", sk[0].row_id);
    expect(row?.member_user_id).toBe(SCOPE);
    expect(Number(row?.key_epoch)).toBe(0);
  });
});

describe("C-3 blob decode on apply", () => {
  it("applyRemoteUpsert base64-decodes account_escrow blob columns to local BLOBs", () => {
    // device-1 escrow row (real ciphertext), captured as a wire row
    keystore.setPassphrase("pw", { params: FAST, recoveryCode: "REC" });
    const local = db()
      .query("SELECT * FROM account_escrow WHERE id = 1")
      .get() as Record<string, unknown>;
    const wire = toWire("account_escrow", local, SCOPE);
    expect(typeof wire.wrapped_secret).toBe("string"); // base64 on the wire

    clearKeystore();
    syncData.applyRemoteUpsert("account_escrow", { ...wire });
    const applied = db()
      .query("SELECT * FROM account_escrow WHERE id = 1")
      .get() as Record<string, unknown>;
    // the local column is a BLOB again, byte-identical to device-1's
    expect(
      eq(
        new Uint8Array(applied.wrapped_secret as Buffer),
        new Uint8Array(local.wrapped_secret as Buffer),
      ),
    ).toBe(true);
    expect(
      eq(
        new Uint8Array(applied.kdf_salt as Buffer),
        new Uint8Array(local.kdf_salt as Buffer),
      ),
    ).toBe(true);
  });

  it("apply runs under suppression (no echo re-enqueue)", () => {
    keystore.setPassphrase("pw", { params: FAST });
    const local = db()
      .query("SELECT * FROM account_escrow WHERE id = 1")
      .get() as Record<string, unknown>;
    const wire = toWire("account_escrow", local, SCOPE);
    clearKeystore();
    syncData.applyRemoteUpsert("account_escrow", { ...wire });
    expect(
      syncData.readOutbox(0).filter((e) => e.table_name === "account_escrow"),
    ).toHaveLength(0);
  });
});

describe("C-3 applyRemoteScopeKey", () => {
  it("reconstructs local scope_id from remote, decodes the wrapped DEK, invalidates cache", async () => {
    const dek = await keystore.getScopeKey(SCOPE, SCOPE);
    const local = db()
      .query("SELECT * FROM scope_keys WHERE member_user_id = ?")
      .get(SCOPE) as Record<string, unknown>;
    const wire = toWire("scope_keys", local, SCOPE);

    // fresh device (identity preserved so it can unwrap; keys wiped)
    db().exec("DELETE FROM scope_keys; DELETE FROM sync_outbox");
    keystore.lock();
    syncData.applyRemoteScopeKey({ ...wire });

    const applied = db()
      .query("SELECT * FROM scope_keys WHERE member_user_id = ?")
      .get(SCOPE) as Record<string, unknown>;
    expect(applied.scope_id).toBe(SCOPE); // reconstructed NOT-NULL local column
    // unwraps back to the same DEK, and no echo enqueue
    expect(eq(await keystore.getScopeKey(SCOPE, SCOPE), dek)).toBe(true);
    expect(
      syncData.readOutbox(0).filter((e) => e.table_name === "scope_keys"),
    ).toHaveLength(0);
  });
});

describe("C-3 end-to-end — fresh device recovers identity + DEK via the pulled key store", () => {
  it("device-2 applies escrow + scope_keys, unlocks, and unwraps the SAME DEK", async () => {
    // device-1: identity + scope DEK + passphrase escrow
    const id1 = keystore.getAccountIdentity();
    const dek1 = await keystore.getScopeKey(SCOPE, SCOPE);
    keystore.setPassphrase("hunter2", { params: FAST });

    const escrowWire = toWire(
      "account_escrow",
      db().query("SELECT * FROM account_escrow WHERE id = 1").get() as Record<
        string,
        unknown
      >,
      SCOPE,
    );
    const skWire = toWire(
      "scope_keys",
      db()
        .query("SELECT * FROM scope_keys WHERE member_user_id = ?")
        .get(SCOPE) as Record<string, unknown>,
      SCOPE,
    );

    // device-2: totally fresh — nothing local, then it PULLS the two key rows
    clearKeystore();
    syncData.applyRemoteUpsert("account_escrow", { ...escrowWire });
    syncData.applyRemoteScopeKey({ ...skWire });

    // locked until unlock (escrow present, no identity)
    expect(keystore.hasAccountIdentity()).toBe(false);
    expect(keystore.unlockWithPassphrase("hunter2")).toBe(true);
    expect(eq(keystore.getAccountIdentity().secretKey, id1.secretKey)).toBe(
      true,
    );
    expect(eq(await keystore.getScopeKey(SCOPE, SCOPE), dek1)).toBe(true);
  });
});
