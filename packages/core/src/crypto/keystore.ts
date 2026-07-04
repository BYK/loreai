/**
 * Local encryption key store (C-2, #825). Persists the per-user account identity
 * keypair and per-scope DEKs, and drives passphrase escrow (set / unlock). Built on
 * the pure primitives in ./keys + ./envelope.
 *
 * v1 model (personal):
 *  - ONE account identity keypair (X25519), stored LOCAL-ONLY in `account_identity`.
 *    The secret sits in the clear in the local db — which is already the plaintext
 *    store for conversations/knowledge, protected by the db file's 0600 mode.
 *    Encryption protects only what is pushed to the REMOTE.
 *  - Per-scope DEK (32 bytes), wrapped (HPKE) to the account public key, in
 *    `scope_keys`. The DEK plaintext is NEVER persisted — it is unwrapped on demand
 *    and cached in memory for the process.
 *  - Escrow: the account secret wrapped by an Argon2id(passphrase) KEK in
 *    `account_escrow`, so a fresh device recovers the SAME account key with the
 *    passphrase (C-3 syncs the escrow + scope_keys rows). A per-device keypair /
 *    QR-PAKE pairing is the client-only alternative deferred to C-5.
 *
 * HPKE wrap/unwrap are async (WebCrypto), so DEK operations are async; escrow
 * (Argon2id + XChaCha) is sync.
 */
import { db } from "../db";
import {
  DEFAULT_KDF_PARAMS,
  deriveKek,
  generateDek,
  generateIdentityKeypair,
  generateKdfSalt,
  identityPublicKey,
  type KdfParams,
  type Keypair,
  unwrapDek,
  unwrapWithKek,
  wrapDekForMember,
  wrapWithKek,
} from "./keys";

/**
 * Thrown when the account identity is not present locally but an escrow record IS —
 * i.e. a fresh device that must `unlockWithPassphrase` before it can encrypt/decrypt.
 * Callers (C-4) treat this as "encryption unavailable this session", never auto-create
 * a new identity (that key could not unwrap DEKs wrapped to the real account key).
 */
export class KeystoreLockedError extends Error {
  constructor() {
    super(
      "keystore is locked: an escrow record exists but no local identity — unlock first",
    );
    this.name = "KeystoreLockedError";
  }
}

// Process-lifetime caches. Cleared by lock(); tests get a fresh db + call lock().
let identityCache: Keypair | null = null;
const dekCache = new Map<string, Uint8Array>();
// In-flight getScopeKey promises, keyed by scopeId (same key as dekCache). Dedups
// concurrent first-use calls for one scope so exactly ONE DEK is generated + stored —
// otherwise two racing callers each generate a DEK and the second write clobbers the
// first, permanently orphaning anything the losing caller encrypted.
const pendingScopeKey = new Map<string, Promise<Uint8Array>>();
// Bumped by lock()/installIdentity. An in-flight loadOrCreateScopeKey captures the
// epoch at start and only writes its result into dekCache if the epoch is unchanged —
// so a promise that was already resolving when lock() cleared the cache (or when the
// identity was swapped) can NEVER repopulate it with now-stale key material.
let keystoreEpoch = 0;

function toU8(v: unknown): Uint8Array {
  return new Uint8Array(v as Uint8Array);
}

/** Clear in-memory key material (identity + DEK cache). Also used to simulate a fresh process/device in tests. */
export function lock(): void {
  identityCache = null;
  dekCache.clear();
  pendingScopeKey.clear();
  keystoreEpoch++;
}

/** True if this device already holds the account identity locally. */
export function hasAccountIdentity(): boolean {
  if (identityCache) return true;
  return !!db().query("SELECT 1 FROM account_identity WHERE id = 1").get();
}

/** True if an escrow record exists (passphrase set, locally or pulled). */
export function hasEscrow(): boolean {
  return !!db().query("SELECT 1 FROM account_escrow WHERE id = 1").get();
}

/**
 * The account identity keypair. Created on genuine first use (no identity AND no
 * escrow). If an escrow record exists but the identity is absent, this is a fresh
 * device that must unlock first — throws {@link KeystoreLockedError} rather than
 * minting a divergent key.
 */
export function getAccountIdentity(): Keypair {
  if (identityCache) return identityCache;
  const row = db()
    .query(
      "SELECT public_key AS pub, secret_key AS sec FROM account_identity WHERE id = 1",
    )
    .get() as { pub: unknown; sec: unknown } | undefined;
  if (row) {
    identityCache = { publicKey: toU8(row.pub), secretKey: toU8(row.sec) };
    return identityCache;
  }
  if (hasEscrow()) throw new KeystoreLockedError();
  const kp = generateIdentityKeypair();
  db()
    .query(
      "INSERT INTO account_identity (id, public_key, secret_key, created_at) VALUES (1, ?, ?, ?)",
    )
    .run(Buffer.from(kp.publicKey), Buffer.from(kp.secretKey), Date.now());
  identityCache = kp;
  return kp;
}

/**
 * The DEK for a scope. Generated + wrapped to the account key on first use (personal
 * v1: `memberUserId` defaults to `scopeId`, so `scope_id = member_user_id = user`).
 * Otherwise unwrapped from the stored `scope_keys` row. Cached in memory per scope.
 */
export function getScopeKey(
  scopeId: string,
  memberUserId: string = scopeId,
): Promise<Uint8Array> {
  const cached = dekCache.get(scopeId);
  if (cached) return Promise.resolve(cached);
  const inflight = pendingScopeKey.get(scopeId);
  if (inflight) return inflight;
  const p = loadOrCreateScopeKey(scopeId, memberUserId).finally(() => {
    // Delete only if THIS promise is still the registered one — a lock()/installIdentity
    // may have cleared the map and a newer call may have registered its own promise.
    if (pendingScopeKey.get(scopeId) === p) pendingScopeKey.delete(scopeId);
  });
  pendingScopeKey.set(scopeId, p);
  return p;
}

async function loadOrCreateScopeKey(
  scopeId: string,
  memberUserId: string,
): Promise<Uint8Array> {
  const epoch = keystoreEpoch;
  const id = getAccountIdentity();
  // Only persist into the shared cache if no lock()/identity-swap happened while we
  // were awaiting — otherwise a stale key would leak back in after invalidation. The
  // caller that requested this DEK still receives it (it asked before the reset).
  const cache = (dek: Uint8Array): void => {
    if (keystoreEpoch === epoch) dekCache.set(scopeId, dek);
  };
  const row = db()
    .query(
      "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id = ? AND member_user_id = ?",
    )
    .get(scopeId, memberUserId) as { w: unknown } | undefined;
  if (row) {
    const dek = await unwrapDek(id.secretKey, toU8(row.w));
    cache(dek);
    return dek;
  }
  const dek = generateDek();
  const wrapped = await wrapDekForMember(id.publicKey, dek);
  const now = Date.now();
  // ON CONFLICT DO NOTHING: if a row already exists for this (scope, member) — a
  // concurrent writer won the race — keep theirs and never clobber. Read the persisted
  // row back and unwrap THAT so every caller converges on the one stored DEK; a lost
  // insert can never leave earlier ciphertext unopenable.
  db()
    .query(
      `INSERT INTO scope_keys
         (scope_id, member_user_id, wrapped_dek, key_epoch, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(scope_id, member_user_id) DO NOTHING`,
    )
    .run(scopeId, memberUserId, Buffer.from(wrapped), now, now);
  const stored = db()
    .query(
      "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id = ? AND member_user_id = ?",
    )
    .get(scopeId, memberUserId) as { w: unknown };
  const finalDek = await unwrapDek(id.secretKey, toU8(stored.w));
  cache(finalDek);
  return finalDek;
}

/**
 * Store/replace a wrapped DEK row (used by C-3 pull to apply a peer/other-device's
 * scope_keys row). Invalidates the in-memory DEK cache for that scope so the next
 * getScopeKey unwraps the applied value.
 */
export function putWrappedScopeKey(
  scopeId: string,
  memberUserId: string,
  wrappedDek: Uint8Array,
  keyEpoch: number,
  updatedAt: number,
): void {
  const now = Date.now();
  db()
    .query(
      `INSERT INTO scope_keys
         (scope_id, member_user_id, wrapped_dek, key_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, member_user_id) DO UPDATE SET
         wrapped_dek = excluded.wrapped_dek,
         key_epoch = excluded.key_epoch,
         updated_at = excluded.updated_at`,
    )
    .run(
      scopeId,
      memberUserId,
      Buffer.from(wrappedDek),
      keyEpoch,
      now,
      updatedAt,
    );
  dekCache.delete(scopeId);
}

export interface EscrowRecord {
  wrappedSecret: Uint8Array;
  kdfSalt: Uint8Array;
  kdfParams: KdfParams;
  recoveryWrapped: Uint8Array | null;
  recoverySalt: Uint8Array | null;
  keyEpoch: number;
  updatedAt: number;
}

/**
 * Set (or change) the encryption passphrase: wrap the account secret under an
 * Argon2id(passphrase) KEK for escrow. Optionally also wrap it under a recovery code
 * (a second, independent unlock path). Requires the identity to be present/unlocked.
 */
export function setPassphrase(
  passphrase: string,
  opts: { recoveryCode?: string; params?: KdfParams } = {},
): void {
  const id = getAccountIdentity();
  const params = opts.params ?? DEFAULT_KDF_PARAMS;
  const salt = generateKdfSalt();
  const wrapped = wrapWithKek(
    deriveKek(passphrase, salt, params),
    id.secretKey,
  );
  let recoveryWrapped: Buffer | null = null;
  let recoverySalt: Buffer | null = null;
  if (opts.recoveryCode) {
    const rsalt = generateKdfSalt();
    recoveryWrapped = Buffer.from(
      wrapWithKek(deriveKek(opts.recoveryCode, rsalt, params), id.secretKey),
    );
    recoverySalt = Buffer.from(rsalt);
  }
  // Recovery carries its own kdf params so a later passphrase change under different
  // params cannot invalidate a preserved recovery wrapping.
  const rT = opts.recoveryCode ? params.t : null;
  const rM = opts.recoveryCode ? params.m : null;
  const rP = opts.recoveryCode ? params.p : null;
  const now = Date.now();
  db()
    .query(
      `INSERT INTO account_escrow
         (id, wrapped_secret, kdf_salt, kdf_t, kdf_m, kdf_p,
          recovery_wrapped, recovery_salt, recovery_kdf_t, recovery_kdf_m, recovery_kdf_p,
          key_epoch, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         wrapped_secret = excluded.wrapped_secret,
         kdf_salt = excluded.kdf_salt, kdf_t = excluded.kdf_t, kdf_m = excluded.kdf_m, kdf_p = excluded.kdf_p,
         -- A passphrase change does NOT change the identity secret, so an existing
         -- recovery wrapping (+ its own kdf params) stays valid. Preserve it unless a
         -- NEW recovery code is supplied (COALESCE keeps the old value when excluded.*
         -- is NULL) — never silently destroy the user's only passphrase-loss path.
         recovery_wrapped = COALESCE(excluded.recovery_wrapped, account_escrow.recovery_wrapped),
         recovery_salt = COALESCE(excluded.recovery_salt, account_escrow.recovery_salt),
         recovery_kdf_t = COALESCE(excluded.recovery_kdf_t, account_escrow.recovery_kdf_t),
         recovery_kdf_m = COALESCE(excluded.recovery_kdf_m, account_escrow.recovery_kdf_m),
         recovery_kdf_p = COALESCE(excluded.recovery_kdf_p, account_escrow.recovery_kdf_p),
         updated_at = excluded.updated_at`,
    )
    .run(
      Buffer.from(wrapped),
      Buffer.from(salt),
      params.t,
      params.m,
      params.p,
      recoveryWrapped,
      recoverySalt,
      rT,
      rM,
      rP,
      now,
      now,
    );
}

function installIdentity(secretKey: Uint8Array): void {
  const publicKey = identityPublicKey(secretKey);
  db()
    .query(
      `INSERT INTO account_identity (id, public_key, secret_key, created_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key, secret_key = excluded.secret_key`,
    )
    .run(Buffer.from(publicKey), Buffer.from(secretKey), Date.now());
  identityCache = { publicKey, secretKey };
  // Swapping the identity invalidates all cached + in-flight DEKs (they may have been
  // unwrapped under the previous identity). Bump the epoch so any in-flight
  // loadOrCreateScopeKey cannot write a stale DEK back into the cache after the swap.
  dekCache.clear();
  pendingScopeKey.clear();
  keystoreEpoch++;
}

function unlockWith(
  passphrase: string,
  wrappedCol: "wrapped_secret" | "recovery_wrapped",
  saltCol: "kdf_salt" | "recovery_salt",
  tCol: "kdf_t" | "recovery_kdf_t",
  mCol: "kdf_m" | "recovery_kdf_m",
  pCol: "kdf_p" | "recovery_kdf_p",
): boolean {
  const row = db()
    .query(
      `SELECT ${wrappedCol} AS w, ${saltCol} AS salt, ${tCol} AS t, ${mCol} AS m, ${pCol} AS p FROM account_escrow WHERE id = 1`,
    )
    .get() as
    | {
        w: unknown;
        salt: unknown;
        t: number | null;
        m: number | null;
        p: number | null;
      }
    | undefined;
  if (!row) throw new Error("keystore: no escrow record to unlock");
  // this unlock path was not configured (e.g. no recovery code) → all its cols NULL
  if (
    row.w == null ||
    row.salt == null ||
    row.t == null ||
    row.m == null ||
    row.p == null
  ) {
    return false;
  }
  const kek = deriveKek(passphrase, toU8(row.salt), {
    t: row.t,
    m: row.m,
    p: row.p,
  });
  let secret: Uint8Array;
  try {
    secret = unwrapWithKek(kek, toU8(row.w));
  } catch {
    return false; // wrong passphrase/recovery code → AEAD tag mismatch
  }
  installIdentity(secret);
  return true;
}

/**
 * Recover the account identity from escrow with the passphrase (the fresh-device
 * path). Returns false on a wrong passphrase; throws if there is no escrow record.
 */
export function unlockWithPassphrase(passphrase: string): boolean {
  return unlockWith(
    passphrase,
    "wrapped_secret",
    "kdf_salt",
    "kdf_t",
    "kdf_m",
    "kdf_p",
  );
}

/** Recover the account identity via the recovery code, if one was configured. */
export function unlockWithRecoveryCode(recoveryCode: string): boolean {
  return unlockWith(
    recoveryCode,
    "recovery_wrapped",
    "recovery_salt",
    "recovery_kdf_t",
    "recovery_kdf_m",
    "recovery_kdf_p",
  );
}
