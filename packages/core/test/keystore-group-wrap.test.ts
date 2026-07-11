/**
 * E-4c-2 (#827) — group DEK wrapping. An admin wraps a team scope's DEK to another member's
 * identity public key; the member unwraps the SAME DEK with their own secret. Critically, a
 * joining member with no wrap yet must NEVER mint a fresh (divergent) DEK.
 *
 * Pure keystore/crypto + local SQLite — no Docker (mirrors the C-1/C-2 test style).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  generateIdentityKeypair,
  type Keypair,
  unwrapDek,
} from "../src/crypto/keys";
import { db } from "../src/db";
import { keystore } from "../src/index";

const eq = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));
const A = "11111111-1111-1111-1111-111111111111"; // admin user id
const B = "22222222-2222-2222-2222-222222222222"; // member user id
const TEAM = "33333333-3333-3333-3333-333333333333"; // team scope id

beforeEach(() => {
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys;",
  );
  keystore.lock();
});

// Install a specific account identity to simulate a particular user's device.
function installDevice(kp: Keypair): void {
  db().exec("DELETE FROM account_identity");
  db()
    .query(
      "INSERT INTO account_identity (id, public_key, secret_key, created_at) VALUES (1,?,?,?)",
    )
    .run(Buffer.from(kp.publicKey), Buffer.from(kp.secretKey), Date.now());
  keystore.lock(); // force getAccountIdentity() to reload the swapped key from the db
}
const storedWrap = (member: string): Uint8Array =>
  Buffer.from(
    (
      db()
        .query(
          "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id=? AND member_user_id=?",
        )
        .get(TEAM, member) as { w: Uint8Array }
    ).w,
  );
const storedWrapAt = (member: string, epoch: number): Uint8Array =>
  Buffer.from(
    (
      db()
        .query(
          "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id=? AND member_user_id=? AND key_epoch=?",
        )
        .get(TEAM, member, epoch) as { w: Uint8Array }
    ).w,
  );

describe("keystore — group DEK wrapping (E-4c-2)", () => {
  it("an admin wraps the scope DEK to a member; the member's secret unwraps the SAME DEK", async () => {
    keystore.getAccountIdentity(); // A's device identity (the DEK originator)
    const dek = await keystore.getScopeKey(TEAM, A); // mint + self-wrap to (TEAM, A)
    const member: Keypair = generateIdentityKeypair(); // B's own identity (pubkey from directory)
    await keystore.wrapScopeKeyForMember(TEAM, A, B, member.publicKey);
    // The (TEAM, B) wrap decrypts under B's SECRET key to the exact scope DEK.
    expect(eq(await unwrapDek(member.secretKey, storedWrap(B)), dek)).toBe(
      true,
    );
    // An unrelated key cannot open it.
    const stranger = generateIdentityKeypair();
    await expect(
      unwrapDek(stranger.secretKey, storedWrap(B)),
    ).rejects.toBeTruthy();
  });

  it("the member's device unlocks the DEK via getScopeKey(mint:false)", async () => {
    keystore.getAccountIdentity();
    const dek = await keystore.getScopeKey(TEAM, A);
    const member = generateIdentityKeypair();
    await keystore.wrapScopeKeyForMember(TEAM, A, B, member.publicKey);
    installDevice(member); // now on B's device
    expect(eq(await keystore.getScopeKey(TEAM, B, { mint: false }), dek)).toBe(
      true,
    );
  });

  it("wrapScopeKeyForMember fails closed when the caller does not hold the scope DEK (no self-mint/fork)", async () => {
    keystore.getAccountIdentity(); // an admin-by-role whose own wrap has NOT arrived yet
    const member = generateIdentityKeypair();
    // Must NOT mint a fresh divergent DEK to wrap — it has no DEK of its own to share.
    await expect(
      keystore.wrapScopeKeyForMember(TEAM, A, B, member.publicKey),
    ).rejects.toThrow(/awaiting an admin group-wrap/);
    expect(
      (
        db().query("SELECT COUNT(*) AS n FROM scope_keys").get() as {
          n: number;
        }
      ).n,
    ).toBe(0); // nothing minted or wrapped
  });

  it("re-wrapping a member at the same epoch is an idempotent no-op (avoids 0012 poison)", async () => {
    keystore.getAccountIdentity();
    await keystore.getScopeKey(TEAM, A);
    const member = generateIdentityKeypair();
    await keystore.wrapScopeKeyForMember(TEAM, A, B, member.publicKey);
    const first = storedWrap(B);
    await keystore.wrapScopeKeyForMember(TEAM, A, B, member.publicKey); // second call
    expect(eq(storedWrap(B), first)).toBe(true); // ciphertext unchanged (skipped, not re-sealed)
  });

  it("a joining member NEVER mints a divergent DEK when no wrap exists yet", async () => {
    keystore.getAccountIdentity();
    await expect(
      keystore.getScopeKey(TEAM, B, { mint: false }),
    ).rejects.toThrow(/awaiting an admin group-wrap/);
    // No row created — a fresh (divergent) DEK was NOT minted.
    expect(
      (
        db().query("SELECT COUNT(*) AS n FROM scope_keys").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it("a rejecting mint:false read does not poison a concurrent mint:true (in-flight race)", async () => {
    keystore.getAccountIdentity();
    // Same scopeId, fired together: the member read rejects (no wrap), but the originator mint
    // must still succeed — it must not receive the read's rejection via the shared in-flight slot.
    const [read, minted] = await Promise.allSettled([
      keystore.getScopeKey(TEAM, B, { mint: false }),
      keystore.getScopeKey(TEAM, TEAM), // originator-style mint (mint defaults true)
    ]);
    expect(read.status).toBe("rejected");
    expect(minted.status).toBe("fulfilled");
  });

  it("rotateScopeKey mints a fresh epoch DEK, wraps to all members, and RETAINS old epochs", async () => {
    const admin = keystore.getAccountIdentity(); // A (the DEK originator)
    const dek0 = await keystore.getScopeKey(TEAM, A); // epoch 0
    expect(keystore.currentScopeEpoch(TEAM, A)).toBe(0);
    const member = generateIdentityKeypair(); // B, a remaining member
    // A rotates to epoch 1, re-wrapping to the remaining members (incl. self).
    await keystore.rotateScopeKey(TEAM, 1, [
      { userId: A, publicKey: admin.publicKey },
      { userId: B, publicKey: member.publicKey },
    ]);
    expect(keystore.currentScopeEpoch(TEAM, A)).toBe(1);
    expect(keystore.scopeKeyEpochs(TEAM, A)).toEqual([0, 1]); // BOTH retained
    const dek1 = await keystore.getScopeKey(TEAM, A, { epoch: 1 });
    expect(eq(dek1, dek0)).toBe(false); // a genuinely fresh DEK
    // The OLD epoch stays decryptable (past blobs remain readable).
    expect(eq(await keystore.getScopeKey(TEAM, A, { epoch: 0 }), dek0)).toBe(
      true,
    );
    // getScopeKey with no epoch now defaults to the CURRENT (highest) epoch.
    expect(eq(await keystore.getScopeKey(TEAM, A), dek1)).toBe(true);
    // Member B unwraps the epoch-1 wrap → the same new DEK.
    expect(
      eq(await unwrapDek(member.secretKey, storedWrapAt(B, 1)), dek1),
    ).toBe(true);
  });

  it("personal scopes still mint by default (behavior-preserving)", async () => {
    keystore.getAccountIdentity();
    const dek = await keystore.getScopeKey("user-1"); // memberUserId defaults to scope → mints
    expect(dek.length).toBe(32);
    expect(eq(await keystore.getScopeKey("user-1"), dek)).toBe(true);
  });
});
