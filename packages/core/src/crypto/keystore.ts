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

/**
 * Thrown by getScopeKey(..., { mint: false }) when a scope has no wrapped DEK for this member
 * yet — a joining team member whose admin has not group-wrapped the scope's DEK to them. The
 * caller must DEFER (the DEK is unavailable this cycle), NEVER mint a fresh (divergent) key.
 */
export class ScopeKeyUnavailable extends Error {
  constructor(scopeId: string, memberUserId: string) {
    super(
      `no wrapped DEK for scope ${scopeId} member ${memberUserId} — awaiting an admin group-wrap`,
    );
    this.name = "ScopeKeyUnavailable";
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
 * Whether wire encryption is active for this device (C-4). The sync engine gates
 * knowledge en/decryption on this:
 *  - "off"    — no escrow: encryption was never set up, so sync stays PLAINTEXT (v1
 *               default until C-4b wires the passphrase UX). We gate on ESCROW (not a
 *               bare identity) so we never encrypt with a non-recoverable, escrow-less
 *               auto-minted key — that data would be unrecoverable on any other device.
 *  - "locked" — escrow exists but the identity is not installed (a fresh device pulled
 *               the escrow via C-3 but hasn't unlocked with the passphrase): we can
 *               NEITHER encrypt nor decrypt, so the engine skips the knowledge table.
 *  - "on"     — identity present (original device, or a fresh device post-unlock):
 *               encrypt on push / decrypt on pull.
 */
export function encryptionState(): "off" | "locked" | "on" {
  if (!hasEscrow()) return "off";
  return hasAccountIdentity() ? "on" : "locked";
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

/** dekCache / pendingScopeKey are keyed by (scope, epoch): each rotation epoch has its OWN DEK. */
const dekKey = (scopeId: string, epoch: number): string =>
  `${scopeId}\x1f${epoch}`;

/** All rotation epochs this device holds a wrap for, for (scope, member), ascending. */
export function scopeKeyEpochs(
  scopeId: string,
  memberUserId: string = scopeId,
): number[] {
  return (
    db()
      .query(
        "SELECT key_epoch AS e FROM scope_keys WHERE scope_id = ? AND member_user_id = ? ORDER BY key_epoch",
      )
      .all(scopeId, memberUserId) as { e: number }[]
  ).map((r) => r.e);
}

/** The scope's current (highest) epoch this device can encrypt at; 0 if it holds no wrap yet. */
export function currentScopeEpoch(
  scopeId: string,
  memberUserId: string = scopeId,
): number {
  const eps = scopeKeyEpochs(scopeId, memberUserId);
  return eps.length ? eps[eps.length - 1] : 0;
}

/**
 * The DEK for a scope at a given epoch. Minted + wrapped to the account key on first use
 * (personal v1: `memberUserId` defaults to `scopeId`). Otherwise unwrapped from the stored
 * `scope_keys` row for that epoch. Cached in memory per (scope, epoch) — each rotation epoch has
 * its own DEK. `epoch` defaults to the scope's CURRENT (highest) epoch (what encrypt seals at);
 * decrypt passes the blob's pinned epoch to open past-rotation ciphertext.
 */
export function getScopeKey(
  scopeId: string,
  memberUserId: string = scopeId,
  opts?: { mint?: boolean; epoch?: number },
): Promise<Uint8Array> {
  const epoch = opts?.epoch ?? currentScopeEpoch(scopeId, memberUserId);
  const ckey = dekKey(scopeId, epoch);
  const cached = dekCache.get(ckey);
  if (cached) return Promise.resolve(cached);
  const inflight = pendingScopeKey.get(ckey);
  if (inflight) return inflight;
  // mint defaults to true (the personal / DEK-originator path). A JOINING team member MUST
  // pass mint:false: the scope's DEK is minted once by its originator and wrapped to each
  // member — if a member without a wrap yet minted a FRESH DEK here it would diverge from the
  // scope's real key, making everyone's ciphertext mutually unreadable. mint:false instead
  // throws ScopeKeyUnavailable so the caller defers until an admin group-wraps the DEK to them.
  //
  // mint:false is a DIVERGENCE-SAFETY guard, NOT an access-control boundary. Access control is
  // enforced by RLS (a member reads only their own scope_keys row) + HPKE (an unwrap needs the
  // member's own secret). One device = one identity; a warm dekCache hit is proof THIS device's
  // user already legitimately unwrapped this per-scope DEK, so returning it (below) regardless
  // of memberUserId is correct — memberUserId only selects which wrap row to unwrap on a MISS,
  // and every member's wrap yields the same per-scope DEK. Never treat this flag as authz.
  const mint = opts?.mint ?? true;
  const p = loadOrCreateScopeKey(scopeId, memberUserId, epoch, mint).finally(
    () => {
      // Delete only if THIS promise is still the registered one — a lock()/installIdentity
      // may have cleared the map and a newer call may have registered its own promise.
      if (pendingScopeKey.get(ckey) === p) pendingScopeKey.delete(ckey);
    },
  );
  // Only the MINTING promise is shared as the in-flight one: it produces the scope DEK, so
  // every concurrent caller (mint:true OR a mint:false read racing it) may safely await it. A
  // mint:false read that will REJECT (no wrap yet) must NOT be registered — otherwise a
  // concurrent mint:true originator would receive that rejection via the shared slot and fail
  // to mint (keyed by (scope,epoch), not intent). An unregistered read still caches on success.
  if (mint) pendingScopeKey.set(ckey, p);
  return p;
}

async function loadOrCreateScopeKey(
  scopeId: string,
  memberUserId: string,
  epoch: number,
  mint: boolean,
): Promise<Uint8Array> {
  const kEpoch = keystoreEpoch;
  const id = getAccountIdentity();
  // Only persist into the shared cache if no lock()/identity-swap happened while we
  // were awaiting — otherwise a stale key would leak back in after invalidation. The
  // caller that requested this DEK still receives it (it asked before the reset).
  const cache = (dek: Uint8Array): void => {
    if (keystoreEpoch === kEpoch) dekCache.set(dekKey(scopeId, epoch), dek);
  };
  const row = db()
    .query(
      "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id = ? AND member_user_id = ? AND key_epoch = ?",
    )
    .get(scopeId, memberUserId, epoch) as { w: unknown } | undefined;
  if (row) {
    const dek = await unwrapDek(id.secretKey, toU8(row.w));
    cache(dek);
    return dek;
  }
  // No wrap for this epoch. NEVER mint a ROTATED epoch (rotateScopeKey creates those) and never
  // mint when the caller forbade it (a joining member awaiting a group-wrap). Only the DEK
  // ORIGINATOR mints — always at epoch 0.
  if (!mint || epoch !== 0) {
    throw new ScopeKeyUnavailable(scopeId, memberUserId);
  }
  const dek = generateDek();
  const wrapped = await wrapDekForMember(id.publicKey, dek);
  const now = Date.now();
  // ON CONFLICT DO NOTHING: if an epoch-0 row already exists — a concurrent writer won the race —
  // keep theirs and never clobber. Read the persisted row back and unwrap THAT so every caller
  // converges on the one stored DEK; a lost insert can never leave earlier ciphertext unopenable.
  db()
    .query(
      `INSERT INTO scope_keys
         (scope_id, member_user_id, wrapped_dek, key_epoch, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(scope_id, member_user_id, key_epoch) DO NOTHING`,
    )
    .run(scopeId, memberUserId, Buffer.from(wrapped), now, now);
  const stored = db()
    .query(
      "SELECT wrapped_dek AS w FROM scope_keys WHERE scope_id = ? AND member_user_id = ? AND key_epoch = 0",
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
       ON CONFLICT(scope_id, member_user_id, key_epoch) DO UPDATE SET
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
  // Invalidate only THIS epoch's cached DEK — a pulled canonical wrap may replace a device's
  // divergent local mint at the same epoch (lost first-write-wins race), so the next
  // getScopeKey for (scope, epoch) must re-unwrap the applied value. Other epochs are untouched.
  dekCache.delete(dekKey(scopeId, keyEpoch));
}

/**
 * Rotate the scope's DEK (E-4c-3): mint a FRESH DEK and wrap it to EACH remaining member at
 * `newEpoch`, INSERTing new rows while OLD-epoch rows are retained (so past blobs stay
 * decryptable). New content seals at `newEpoch` once it is the highest local epoch. `newEpoch`
 * MUST be allocated server-atomically via the `rotate_scope_key(scope)` RPC so concurrent admins
 * never mint the same epoch with divergent DEKs. `members` MUST include the caller (self) with
 * their own public key, or the rotator locks itself out of the new epoch. Members + their
 * identity public keys are supplied by the caller (CLI/registry).
 */
export async function rotateScopeKey(
  scopeId: string,
  newEpoch: number,
  members: { userId: string; publicKey: Uint8Array }[],
): Promise<void> {
  const kEpoch = keystoreEpoch;
  const dek = generateDek();
  const now = Date.now();
  // Wrap to ALL members FIRST (async HPKE), THEN persist — so a mid-wrap failure leaves NO
  // partial epoch. Otherwise a half-written epoch + a retry (fresh DEK) would collide with the
  // already-written members at the remote first-write-wins guard (23514 poison).
  const wraps = await Promise.all(
    members.map(async (m) => ({
      userId: m.userId,
      wrapped: await wrapDekForMember(m.publicKey, dek),
    })),
  );
  for (const w of wraps) {
    putWrappedScopeKey(scopeId, w.userId, w.wrapped, newEpoch, now);
  }
  // Cache the fresh DEK for (scope, newEpoch) so the encrypt path uses it immediately — unless a
  // lock()/identity swap raced (then leave it for a fresh unwrap; putWrappedScopeKey already
  // invalidated the slot).
  if (keystoreEpoch === kEpoch) dekCache.set(dekKey(scopeId, newEpoch), dek);
}

/**
 * Group-wrap: an ADMIN wraps a scope's DEK to another member's identity public key and stores
 * the `scope_keys(scope, member)` row locally (the sync engine pushes it to the remote so the
 * member's device can pull + unwrap it). `selfUserId` is the caller, whose own self-wrap holds
 * the scope DEK. HPKE: only `memberPublicKey` is needed — the member unwraps with their secret.
 *
 * FAIL-CLOSED: the self-lookup is `mint:false`. The caller must ALREADY hold the scope DEK
 * (throws ScopeKeyUnavailable otherwise) — this primitive NEVER originates a key. That closes a
 * fork hazard: an admin-by-role who does not yet hold their own wrap (e.g. the window between
 * add_scope_member(...,'admin') and their wrap arriving) must not mint a FRESH divergent DEK and
 * then propagate it. Origination is a separate, explicit step (the DEK originator mints via the
 * normal content-encrypt path / getScopeKey(scope) before wrapping to anyone).
 *
 * The wrap is sealed at the scope's CURRENT epoch (read from the caller's own row), so this
 * stays correct once rotation (E-4c-3) bumps epochs. IDEMPOTENT: skips the write if the member
 * already holds a wrap at this epoch or newer — HPKE is non-deterministic, so re-wrapping would
 * emit different ciphertext that the remote first-write-wins guard (0012) rejects as poison.
 */
export async function wrapScopeKeyForMember(
  scopeId: string,
  selfUserId: string,
  memberUserId: string,
  memberPublicKey: Uint8Array,
): Promise<void> {
  const dek = await getScopeKey(scopeId, selfUserId, { mint: false });
  const epochOf = (member: string): number | undefined =>
    (
      db()
        .query(
          "SELECT key_epoch AS e FROM scope_keys WHERE scope_id = ? AND member_user_id = ? ORDER BY key_epoch DESC LIMIT 1",
        )
        .get(scopeId, member) as { e: number } | undefined
    )?.e;
  const epoch = epochOf(selfUserId) ?? 0;
  const existing = epochOf(memberUserId);
  if (existing !== undefined && existing >= epoch) return; // already wrapped at ≥ this epoch
  const wrapped = await wrapDekForMember(memberPublicKey, dek);
  putWrappedScopeKey(scopeId, memberUserId, wrapped, epoch, Date.now());
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
