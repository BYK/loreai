/**
 * Lore client-side encryption primitives (epic #821 "C", issue #825).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY libsodium/HPKE NOW, MLS LATER (epic decision #6 — 🔴 documented here at the seam)
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal: Supabase stores CIPHERTEXT only for sensitive blobs (near-zero-knowledge).
 * We do NOT need server-side search on those blobs — which is exactly what makes
 * client-side encryption viable here.
 *
 * Scheme (v1): a per-scope symmetric **DEK** (XChaCha20-Poly1305) encrypts blob
 * columns; the DEK is WRAPPED per member to their X25519 identity key with **HPKE**
 * (RFC 9180). Every blob carries a **versioned envelope** (`scheme_id` + `key_epoch`),
 * so a future scheme is ADDITIVE: old ciphertext keeps decrypting under its recorded
 * scheme, with NO bulk re-encryption.
 *
 * We deliberately do NOT use Signal's Double Ratchet / Sender Keys: those buy FORWARD
 * SECRECY for real-time chat, which actively FIGHTS a backup/sync product whose whole
 * job is to let a freshly-paired device read OLD data. HPKE's KEM/DEM wrapping matches
 * "wrap this durable key to these members" exactly.
 *
 * Threshold to add **MLS (RFC 9420)** as scheme_id 2 (additive, behind the same
 * wrap interface): org-scale groups, high membership churn, or a requirement for
 * forward secrecy / post-compromise security (PCS). Until then HPKE per-member
 * wrapping is simpler and sufficient. Key-agreement is isolated behind
 * `wrapDekForMember` / `unwrapDek` so that swap needs no change at call sites.
 *
 * 🔴 NEVER hand-roll crypto. Scheme 1 = @noble/ciphers (audited XChaCha20-Poly1305);
 * DEK wrap = @hpke/core (RFC 9180); escrow KEK = @noble/hashes Argon2id. See also the
 * architecture doc `docs/` (encryption section) which mirrors this rationale.
 *
 * Invariants (🔴): the server never sees plaintext of encrypted blobs; only blob
 * columns are encrypted (ids/timestamps/scope_id/author_id/content_hash/cursors stay
 * cleartext for sync mechanics); encrypted blobs are immutable ciphertext (new A2
 * version = new blob, never re-encrypt in place).
 *
 * This module is PURE (no DB, no network). The keystore that persists identity keys +
 * per-scope DEKs and drives escrow/unlock lives in C-2 (crypto/keystore.ts).
 */
export {
  buildAad,
  type EnvelopeHeader,
  isEnvelope,
  open,
  parseHeader,
  SCHEME_XCHACHA20POLY1305,
  seal,
} from "./envelope";
export {
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
