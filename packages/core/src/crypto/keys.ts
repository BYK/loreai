/**
 * Key material for the encryption seam (C, epic #821 decisions #6/#7).
 *
 * Layered model (v1 = personal; group wrapping is E):
 *   - Per-account **identity keypair** (X25519). Its private key is the crown jewel;
 *     at rest it is protected by the key-management model (escrow or client-only).
 *   - Per-scope **DEK** (32 random bytes) encrypts blob columns via ./envelope.
 *   - The DEK is WRAPPED to a recipient's identity public key with HPKE (RFC 9180,
 *     DHKEM-X25519-HKDF-SHA256 + HKDF-SHA256 + AES-256-GCM) — a standard, vetted KEM/DEM,
 *     never a hand-rolled sealed box. v1 wraps only to the user's own identity key.
 *   - **Escrow:** the identity private key is wrapped by an Argon2id(passphrase) KEK
 *     (XChaCha20-Poly1305 via ./envelope) and stored server-side, so any device with
 *     the passphrase recovers it. A recovery code is a second, independent wrapping.
 *
 * Key-agreement lives behind this interface (wrapDekForMember / unwrapDek), so MLS can
 * later replace HPKE additively. See ./index.ts for the full rationale + threshold.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { argon2id } from "@noble/hashes/argon2.js";
import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { open as envOpen, seal as envSeal } from "./envelope";

export interface Keypair {
  /** X25519 secret (private) key, 32 bytes. */
  secretKey: Uint8Array;
  /** X25519 public key, 32 bytes. */
  publicKey: Uint8Array;
}

/** HPKE wrap-scheme identifiers (self-describing wrapped-DEK header). */
const WRAP_HPKE_X25519 = 1 as const;
/** DHKEM-X25519 encapsulated-key length (the ephemeral public key). */
const HPKE_ENC_LEN = 32;
/**
 * HPKE `info` — domain-separates Lore's DEK wrapping from any other HPKE use of the
 * same identity key, and binds the wrap to this scheme version. (Per-scope/epoch
 * binding via `info` is a group-wrapping concern deferred to epic E; personal v1 is
 * additionally protected because a mis-targeted DEK simply fails the blob open.)
 */
const HPKE_INFO_BYTES = new TextEncoder().encode("lore-dek-wrap-v1");
function hpkeInfo(): ArrayBuffer {
  const out = new ArrayBuffer(HPKE_INFO_BYTES.length);
  new Uint8Array(out).set(HPKE_INFO_BYTES);
  return out;
}

/** Argon2id parameters. Stored alongside the escrow blob so they can be reproduced. */
export interface KdfParams {
  /** Iterations (time cost). */
  t: number;
  /** Memory cost in KiB. */
  m: number;
  /** Parallelism. */
  p: number;
}

/**
 * OWASP-aligned defaults: 64 MiB memory, 3 passes, parallelism 1. `p=1` because the
 * pure-JS Argon2id runs single-threaded — a higher lane count buys no defensive
 * parallelism here, it only multiplies the legitimate user's unlock latency. Memory
 * hardness (64 MiB) is the primary attacker cost. Tune to a target unlock latency on
 * min-spec hardware if needed.
 */
export const DEFAULT_KDF_PARAMS: KdfParams = { t: 3, m: 65536, p: 1 };
const KEK_LEN = 32;
const SALT_LEN = 16;
const DEK_LEN = 32;

function hpkeSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
}

/** A fresh, exact-length ArrayBuffer copy (the @hpke/core APIs take ArrayBuffer). */
function ab(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
}

/** Generate a new X25519 identity keypair. */
export function generateIdentityKeypair(): Keypair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The X25519 public key for a given secret key. */
export function identityPublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32)
    throw new Error("identity secret key must be 32 bytes");
  return x25519.getPublicKey(secretKey);
}

/** A fresh 32-byte data-encryption key (DEK). */
export function generateDek(): Uint8Array {
  return randomBytes(DEK_LEN);
}

/**
 * Wrap `dek` to a recipient's identity public key with HPKE. Returns a self-describing
 * blob: `[wrap_scheme(1)][enc(32)][hpke_ct]`. Only the holder of the matching identity
 * secret key can unwrap it. Async: HPKE contexts use WebCrypto.
 */
export async function wrapDekForMember(
  recipientPublicKey: Uint8Array,
  dek: Uint8Array,
): Promise<Uint8Array> {
  if (recipientPublicKey.length !== 32)
    throw new Error("recipient pubkey must be 32 bytes");
  if (dek.length !== DEK_LEN) throw new Error("DEK must be 32 bytes");
  const suite = hpkeSuite();
  const rpk = await suite.kem.importKey("raw", ab(recipientPublicKey), true);
  const sender = await suite.createSenderContext({
    recipientPublicKey: rpk,
    info: hpkeInfo(),
  });
  const ct = new Uint8Array(await sender.seal(ab(dek)));
  const enc = new Uint8Array(sender.enc);
  const out = new Uint8Array(1 + enc.length + ct.length);
  out[0] = WRAP_HPKE_X25519;
  out.set(enc, 1);
  out.set(ct, 1 + enc.length);
  return out;
}

/**
 * Unwrap a DEK wrapped by {@link wrapDekForMember} using the recipient's identity
 * secret key. Throws on an unknown wrap scheme, a wrong key, or a tampered blob.
 */
export async function unwrapDek(
  recipientSecretKey: Uint8Array,
  wrapped: Uint8Array,
): Promise<Uint8Array> {
  if (recipientSecretKey.length !== 32)
    throw new Error("recipient secret key must be 32 bytes");
  if (wrapped.length < 1 + HPKE_ENC_LEN)
    throw new Error("wrapped DEK: too short");
  if (wrapped[0] !== WRAP_HPKE_X25519) {
    throw new Error(`wrapped DEK: unsupported wrap scheme ${wrapped[0]}`);
  }
  const enc = ab(wrapped.subarray(1, 1 + HPKE_ENC_LEN));
  const ct = ab(wrapped.subarray(1 + HPKE_ENC_LEN));
  const suite = hpkeSuite();
  const rsk = await suite.kem.importKey("raw", ab(recipientSecretKey), false);
  const recipient = await suite.createRecipientContext({
    recipientKey: rsk,
    enc,
    info: hpkeInfo(),
  });
  return new Uint8Array(await recipient.open(ct));
}

/** A fresh random Argon2id salt. */
export function generateKdfSalt(): Uint8Array {
  return randomBytes(SALT_LEN);
}

/** Derive a 32-byte key-encryption key (KEK) from a passphrase via Argon2id. */
export function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Uint8Array {
  const pw = new TextEncoder().encode(passphrase);
  return argon2id(pw, salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: KEK_LEN,
  });
}

const ESCROW_AAD = new TextEncoder().encode("lore-escrow-v1");

/**
 * Wrap a secret (e.g. the identity private key) under a passphrase-derived KEK, for
 * server-side escrow. Reuses the audited XChaCha20-Poly1305 envelope; the escrow AAD
 * domain-separates it from blob-column ciphertext.
 */
export function wrapWithKek(kek: Uint8Array, secret: Uint8Array): Uint8Array {
  if (kek.length !== KEK_LEN) throw new Error("KEK must be 32 bytes");
  return envSeal(kek, secret, ESCROW_AAD);
}

/** Unwrap a secret wrapped by {@link wrapWithKek}. Throws on a wrong KEK or tamper. */
export function unwrapWithKek(
  kek: Uint8Array,
  wrapped: Uint8Array,
): Uint8Array {
  if (kek.length !== KEK_LEN) throw new Error("KEK must be 32 bytes");
  return envOpen(kek, wrapped, ESCROW_AAD);
}
