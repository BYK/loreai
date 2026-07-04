/**
 * Versioned encryption envelope for sync blob columns (A2/C, epic #821 decision #6).
 *
 * Every encrypted blob is self-describing: a fixed header names the AEAD scheme and
 * the key epoch, so decryption dispatches on the stored `scheme_id` and MLS (RFC 9420)
 * can later be added as an ADDITIVE scheme (scheme_id 2) — old ciphertext stays
 * readable, NO re-encryption. The header's metadata is authenticated as additional
 * data (AAD), so a scheme/epoch downgrade or a transplant across rows is detected as a
 * tamper (tag mismatch), never silently accepted.
 *
 * We do NOT hand-roll crypto: scheme 1 is @noble/ciphers' audited XChaCha20-Poly1305
 * (a 192-bit random nonce makes per-message random nonces collision-safe without a
 * counter). See ./index.ts for the libsodium/HPKE→MLS rationale + threshold.
 *
 * Wire layout (scheme 1):
 *   off size field
 *   0   2    magic 0x4C 0x45 ("LE")
 *   2   1    scheme_id
 *   3   4    key_epoch (uint32 big-endian)
 *   7   24   nonce (XChaCha20 24-byte nonce)
 *   31  *    ciphertext || Poly1305 tag (16 bytes, appended by the AEAD)
 * AEAD additional data = header[0..7) (magic|scheme_id|key_epoch) || callerAad.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";

/** AEAD scheme identifiers. MLS/HPKE-rekeyed schemes are added here, additively. */
export const SCHEME_XCHACHA20POLY1305 = 1 as const;

const MAGIC0 = 0x4c; // 'L'
const MAGIC1 = 0x45; // 'E'
const META_LEN = 7; // magic(2) + scheme_id(1) + key_epoch(4)
const NONCE_LEN = 24; // XChaCha20 nonce
const HEADER_LEN = META_LEN + NONCE_LEN; // 31

export interface EnvelopeHeader {
  schemeId: number;
  keyEpoch: number;
  /** The AEAD nonce (scheme 1: 24 bytes). */
  nonce: Uint8Array;
  /** Ciphertext + tag (everything after the header). */
  body: Uint8Array;
  /** The authenticated metadata prefix (magic|scheme_id|key_epoch). */
  meta: Uint8Array;
}

/**
 * Concatenate the authenticated-metadata prefix with the caller's context AAD. An
 * empty/absent callerAad carries no context, so it is treated as "no extra AAD".
 */
function aadFor(meta: Uint8Array, callerAad?: Uint8Array): Uint8Array {
  if (!callerAad || callerAad.length === 0) return meta;
  const out = new Uint8Array(meta.length + callerAad.length);
  out.set(meta, 0);
  out.set(callerAad, meta.length);
  return out;
}

/**
 * Build a context AAD from multiple parts UNAMBIGUOUSLY. Callers bind ciphertext to
 * its row/column (e.g. `scope_id`, column name, `logical_id`); naive string concat is
 * a footgun — `("ab","c")` and `("a","bc")` would collide. Each part is length-
 * prefixed (4-byte big-endian) so distinct part boundaries always produce distinct
 * AAD. ALWAYS build context AAD with this helper; never hand-concatenate.
 */
export function buildAad(...parts: Array<Uint8Array | string>): Uint8Array {
  const te = new TextEncoder();
  const bufs = parts.map((p) => (typeof p === "string" ? te.encode(p) : p));
  const total = bufs.reduce((n, b) => n + 4 + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bufs) {
    out[o] = (b.length >>> 24) & 0xff;
    out[o + 1] = (b.length >>> 16) & 0xff;
    out[o + 2] = (b.length >>> 8) & 0xff;
    out[o + 3] = b.length & 0xff;
    o += 4;
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/**
 * Encrypt `plaintext` under `dek`, producing a versioned envelope. `aad` binds the
 * ciphertext to its context (e.g. scope_id || column || logical_id) so it cannot be
 * transplanted to another row/column. `keyEpoch` records which DEK version sealed it.
 */
export function seal(
  dek: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
  opts: { keyEpoch?: number } = {},
): Uint8Array {
  const keyEpoch = opts.keyEpoch ?? 0;
  if (dek.length !== 32) throw new Error("seal: DEK must be 32 bytes");
  if (keyEpoch < 0 || keyEpoch > 0xffffffff || !Number.isInteger(keyEpoch)) {
    throw new Error("seal: keyEpoch must be a uint32");
  }
  const nonce = randomBytes(NONCE_LEN);
  const header = new Uint8Array(HEADER_LEN);
  header[0] = MAGIC0;
  header[1] = MAGIC1;
  header[2] = SCHEME_XCHACHA20POLY1305;
  // key_epoch, big-endian
  header[3] = (keyEpoch >>> 24) & 0xff;
  header[4] = (keyEpoch >>> 16) & 0xff;
  header[5] = (keyEpoch >>> 8) & 0xff;
  header[6] = keyEpoch & 0xff;
  header.set(nonce, META_LEN);
  const meta = header.subarray(0, META_LEN);
  const ct = xchacha20poly1305(dek, nonce, aadFor(meta, aad)).encrypt(
    plaintext,
  );
  const out = new Uint8Array(HEADER_LEN + ct.length);
  out.set(header, 0);
  out.set(ct, HEADER_LEN);
  return out;
}

/** Parse (but do not decrypt) a versioned envelope's header. Throws on a bad frame. */
export function parseHeader(envelope: Uint8Array): EnvelopeHeader {
  if (envelope.length < HEADER_LEN) throw new Error("envelope: too short");
  if (envelope[0] !== MAGIC0 || envelope[1] !== MAGIC1) {
    throw new Error("envelope: bad magic");
  }
  const schemeId = envelope[2];
  const keyEpoch =
    ((envelope[3] << 24) |
      (envelope[4] << 16) |
      (envelope[5] << 8) |
      envelope[6]) >>>
    0;
  return {
    schemeId,
    keyEpoch,
    nonce: envelope.subarray(META_LEN, HEADER_LEN),
    body: envelope.subarray(HEADER_LEN),
    meta: envelope.subarray(0, META_LEN),
  };
}

/**
 * Decrypt a versioned envelope. Dispatches on the stored scheme_id. `aad` MUST match
 * the value passed to `seal` (same context binding) or the AEAD tag check fails. A
 * wrong DEK, a tampered header/body, or a mismatched AAD all throw.
 */
export function open(
  dek: Uint8Array,
  envelope: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  const h = parseHeader(envelope);
  if (h.schemeId !== SCHEME_XCHACHA20POLY1305) {
    throw new Error(`envelope: unsupported scheme_id ${h.schemeId}`);
  }
  if (dek.length !== 32) throw new Error("open: DEK must be 32 bytes");
  return xchacha20poly1305(dek, h.nonce, aadFor(h.meta, aad)).decrypt(h.body);
}

/**
 * True if `bytes` begins with a recognizable envelope frame (magic + known scheme).
 * NOTE: the scheme check must be widened when a new scheme_id (e.g. MLS = 2) is added,
 * or a valid future-scheme blob would be misreported as non-envelope.
 */
export function isEnvelope(bytes: Uint8Array): boolean {
  return (
    bytes.length >= HEADER_LEN &&
    bytes[0] === MAGIC0 &&
    bytes[1] === MAGIC1 &&
    bytes[2] === SCHEME_XCHACHA20POLY1305
  );
}
