import { describe, expect, it } from "vitest";
import { crypto as lc } from "../src/index";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
// Light Argon2id params for tests: correctness (determinism / round-trip) is
// independent of the work factor, so keep CI fast. Production uses DEFAULT_KDF_PARAMS.
const FAST = { t: 1, m: 256, p: 1 };

describe("crypto/envelope — versioned AEAD", () => {
  it("round-trips plaintext under a DEK with context AAD", () => {
    const dek = lc.generateDek();
    const aad = enc("scope|content|logical-1");
    const blob = lc.seal(dek, enc("secret note"), aad);
    expect(dec(lc.open(dek, blob, aad))).toBe("secret note");
  });

  it("is self-describing: header carries scheme_id + key_epoch", () => {
    const dek = lc.generateDek();
    const blob = lc.seal(dek, enc("x"), undefined, { keyEpoch: 7 });
    const h = lc.parseHeader(blob);
    expect(h.schemeId).toBe(lc.SCHEME_XCHACHA20POLY1305);
    expect(h.keyEpoch).toBe(7);
    expect(h.nonce.length).toBe(24);
    expect(lc.isEnvelope(blob)).toBe(true);
  });

  it("round-trips a large uint32 key_epoch", () => {
    const dek = lc.generateDek();
    const blob = lc.seal(dek, enc("x"), undefined, { keyEpoch: 0xfffffffe });
    expect(lc.parseHeader(blob).keyEpoch).toBe(0xfffffffe);
    expect(dec(lc.open(dek, blob))).toBe("x");
  });

  it("fails to open under a wrong DEK", () => {
    const blob = lc.seal(lc.generateDek(), enc("hi"));
    expect(() => lc.open(lc.generateDek(), blob)).toThrow();
  });

  it("fails when the AAD does not match (context binding)", () => {
    const dek = lc.generateDek();
    const blob = lc.seal(dek, enc("hi"), enc("scope-A|content|l1"));
    expect(() => lc.open(dek, blob, enc("scope-B|content|l1"))).toThrow();
    // omitting the AAD entirely must also fail
    expect(() => lc.open(dek, blob)).toThrow();
  });

  it("detects tampering in the body and in the authenticated header metadata", () => {
    const dek = lc.generateDek();
    const aad = enc("ctx");
    const blob = lc.seal(dek, enc("payload"), aad);
    // flip a ciphertext byte
    const body = Uint8Array.from(blob);
    body[body.length - 1] ^= 0xff;
    expect(() => lc.open(dek, body, aad)).toThrow();
    // flip the key_epoch (byte 3..6) — authenticated as AAD → tag mismatch
    const meta = Uint8Array.from(blob);
    meta[3] ^= 0x01;
    expect(() => lc.open(dek, meta, aad)).toThrow();
  });

  it("rejects a frame with bad magic or an unsupported scheme", () => {
    const dek = lc.generateDek();
    const blob = lc.seal(dek, enc("x"));
    const badMagic = Uint8Array.from(blob);
    badMagic[0] ^= 0xff;
    expect(() => lc.parseHeader(badMagic)).toThrow(/magic/);
    const badScheme = Uint8Array.from(blob);
    badScheme[2] = 99;
    expect(() => lc.open(dek, badScheme)).toThrow(/scheme/);
    expect(lc.isEnvelope(badScheme)).toBe(false);
  });

  it("rejects a non-32-byte DEK and a non-uint32 epoch", () => {
    expect(() => lc.seal(new Uint8Array(16), enc("x"))).toThrow();
    expect(() =>
      lc.seal(lc.generateDek(), enc("x"), undefined, { keyEpoch: -1 }),
    ).toThrow();
  });

  it("uses a fresh random nonce per seal (no nonce reuse across a batch)", () => {
    const dek = lc.generateDek();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = Buffer.from(
        lc.parseHeader(lc.seal(dek, enc("same"))).nonce,
      ).toString("hex");
      expect(seen.has(n)).toBe(false);
      seen.add(n);
    }
  });

  it("round-trips empty plaintext", () => {
    const dek = lc.generateDek();
    const aad = enc("ctx");
    const blob = lc.seal(dek, new Uint8Array(0), aad);
    expect(lc.open(dek, blob, aad).length).toBe(0);
  });

  it("round-trips the sign-bit key_epoch boundary (0x80000000, 0xffffffff)", () => {
    const dek = lc.generateDek();
    for (const epoch of [0x80000000, 0xffffffff]) {
      const blob = lc.seal(dek, enc("x"), undefined, { keyEpoch: epoch });
      expect(lc.parseHeader(blob).keyEpoch).toBe(epoch);
      expect(dec(lc.open(dek, blob))).toBe("x");
    }
  });
});

describe("crypto/buildAad — unambiguous context binding", () => {
  it("produces distinct AAD for distinct part boundaries (no concat collision)", () => {
    const ab1 = lc.buildAad("ab", "c");
    const ab2 = lc.buildAad("a", "bc");
    expect(Buffer.from(ab1).equals(Buffer.from(ab2))).toBe(false);
    // and a blob sealed with one boundary cannot be opened with the other
    const dek = lc.generateDek();
    const blob = lc.seal(dek, enc("secret"), ab1);
    expect(() => lc.open(dek, blob, ab2)).toThrow();
    expect(dec(lc.open(dek, blob, lc.buildAad("ab", "c")))).toBe("secret");
  });

  it("accepts string and byte parts interchangeably by value", () => {
    const a = lc.buildAad("scope-1", "content", "logical-42");
    const b = lc.buildAad(enc("scope-1"), enc("content"), enc("logical-42"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("crypto/keys — identity, DEK wrapping (HPKE), escrow (Argon2id)", () => {
  it("generates 32-byte X25519 identity keypairs; public key is derivable", () => {
    const kp = lc.generateIdentityKeypair();
    expect(kp.secretKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
    expect(Buffer.from(lc.identityPublicKey(kp.secretKey))).toEqual(
      Buffer.from(kp.publicKey),
    );
  });

  it("generates distinct 32-byte DEKs", () => {
    const a = lc.generateDek();
    const b = lc.generateDek();
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("wraps a DEK to an identity public key and unwraps with the secret key", async () => {
    const kp = lc.generateIdentityKeypair();
    const dek = lc.generateDek();
    const wrapped = await lc.wrapDekForMember(kp.publicKey, dek);
    const got = await lc.unwrapDek(kp.secretKey, wrapped);
    expect(Buffer.from(got).equals(Buffer.from(dek))).toBe(true);
  });

  it("unwrapDek requires Lore's HPKE domain-separation info (rejects a foreign-info wrap)", async () => {
    // Wrap the DEK with a DIFFERENT HPKE `info` than Lore's, in Lore's wrap layout
    // [scheme(1)][enc(32)][ct]. unwrapDek pins info="lore-dek-wrap-v1", so it must
    // reject this. Guards against a future both-sides drop of domain separation
    // (which a symmetry-only round-trip test would miss).
    const { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } =
      await import("@hpke/core");
    const kp = lc.generateIdentityKeypair();
    const dek = lc.generateDek();
    const suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    });
    const rpk = await suite.kem.importKey(
      "raw",
      Uint8Array.from(kp.publicKey).buffer,
      true,
    );
    // Wrap with EMPTY info (the HPKE default) — exactly what a dropped-domain-
    // separation unwrapDek would use. If unwrapDek stopped passing Lore's info, this
    // blob would open, so this test catches a both-sides drop of `info`.
    const sender = await suite.createSenderContext({ recipientPublicKey: rpk });
    const ct = new Uint8Array(await sender.seal(Uint8Array.from(dek).buffer));
    const enc = new Uint8Array(sender.enc);
    const wrapped = new Uint8Array(1 + enc.length + ct.length);
    wrapped[0] = 1;
    wrapped.set(enc, 1);
    wrapped.set(ct, 1 + enc.length);
    await expect(lc.unwrapDek(kp.secretKey, wrapped)).rejects.toThrow();
  });

  it("a different member cannot unwrap the DEK", async () => {
    const alice = lc.generateIdentityKeypair();
    const mallory = lc.generateIdentityKeypair();
    const wrapped = await lc.wrapDekForMember(
      alice.publicKey,
      lc.generateDek(),
    );
    await expect(lc.unwrapDek(mallory.secretKey, wrapped)).rejects.toThrow();
  });

  it("detects tampering in the wrapped-DEK enc and ciphertext regions", async () => {
    const kp = lc.generateIdentityKeypair();
    const wrapped = await lc.wrapDekForMember(kp.publicKey, lc.generateDek());
    // enc region is bytes [1, 33); ct region is [33, end)
    const encTamper = Uint8Array.from(wrapped);
    encTamper[5] ^= 0xff;
    await expect(lc.unwrapDek(kp.secretKey, encTamper)).rejects.toThrow();
    const ctTamper = Uint8Array.from(wrapped);
    ctTamper[ctTamper.length - 1] ^= 0xff;
    await expect(lc.unwrapDek(kp.secretKey, ctTamper)).rejects.toThrow();
  });

  it("escrow blobs and content blobs are domain-separated (AAD isolation)", () => {
    const dek = lc.generateDek(); // reuse the 32-byte value as both a DEK and a KEK
    const secret = lc.generateDek();
    const escrow = lc.wrapWithKek(dek, secret);
    // the escrow blob must NOT open as a plain content envelope (different AAD domain)
    expect(() => lc.open(dek, escrow)).toThrow();
    expect(() => lc.open(dek, escrow, enc("content"))).toThrow();
    // and a content blob must NOT unwrap as escrow
    const content = lc.seal(dek, enc("hi"), enc("content"));
    expect(() => lc.unwrapWithKek(dek, content)).toThrow();
  });

  it("rejects a wrapped DEK with an unknown wrap scheme or truncated frame", async () => {
    const kp = lc.generateIdentityKeypair();
    const wrapped = await lc.wrapDekForMember(kp.publicKey, lc.generateDek());
    const badScheme = Uint8Array.from(wrapped);
    badScheme[0] = 99;
    await expect(lc.unwrapDek(kp.secretKey, badScheme)).rejects.toThrow(
      /wrap scheme/,
    );
    await expect(
      lc.unwrapDek(kp.secretKey, wrapped.subarray(0, 4)),
    ).rejects.toThrow();
  });

  it("wrapped DEK is a self-describing blob distinct from the plaintext DEK", async () => {
    const kp = lc.generateIdentityKeypair();
    const dek = lc.generateDek();
    const wrapped = await lc.wrapDekForMember(kp.publicKey, dek);
    expect(wrapped[0]).toBe(1); // WRAP_HPKE_X25519
    expect(wrapped.length).toBeGreaterThan(dek.length);
    expect(Buffer.from(wrapped).includes(Buffer.from(dek))).toBe(false);
  });

  it("derives a deterministic KEK for the same passphrase+salt+params", () => {
    const salt = lc.generateKdfSalt();
    const k1 = lc.deriveKek("correct horse", salt, FAST);
    const k2 = lc.deriveKek("correct horse", salt, FAST);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true);
    expect(k1.length).toBe(32);
  });

  it("the production DEFAULT_KDF_PARAMS derive a valid 32-byte KEK", () => {
    const kek = lc.deriveKek(
      "prod",
      lc.generateKdfSalt(),
      lc.DEFAULT_KDF_PARAMS,
    );
    expect(kek.length).toBe(32);
    expect(lc.DEFAULT_KDF_PARAMS.m).toBeGreaterThanOrEqual(19456); // OWASP floor (KiB)
  });

  it("derives different KEKs for a different passphrase or salt", () => {
    const salt = lc.generateKdfSalt();
    const base = lc.deriveKek("pw", salt, FAST);
    expect(
      Buffer.from(lc.deriveKek("PW", salt, FAST)).equals(Buffer.from(base)),
    ).toBe(false);
    expect(
      Buffer.from(lc.deriveKek("pw", lc.generateKdfSalt(), FAST)).equals(
        Buffer.from(base),
      ),
    ).toBe(false);
  });

  it("escrow: wraps/unwraps the identity secret key under a passphrase KEK", () => {
    const kp = lc.generateIdentityKeypair();
    const salt = lc.generateKdfSalt();
    const kek = lc.deriveKek("master passphrase", salt, FAST);
    const escrow = lc.wrapWithKek(kek, kp.secretKey);
    const recovered = lc.unwrapWithKek(kek, escrow);
    expect(Buffer.from(recovered).equals(Buffer.from(kp.secretKey))).toBe(true);
    // a wrong passphrase → wrong KEK → cannot unwrap
    const wrongKek = lc.deriveKek("WRONG passphrase", salt, FAST);
    expect(() => lc.unwrapWithKek(wrongKek, escrow)).toThrow();
  });
});

describe("crypto — end-to-end personal-scope flow", () => {
  it("identity → DEK wrap → blob seal → recover on a 'fresh device' via escrow", async () => {
    // Device 1: create identity, a scope DEK, wrap the DEK to itself, encrypt a blob.
    const id = lc.generateIdentityKeypair();
    const dek = lc.generateDek();
    const wrappedDek = await lc.wrapDekForMember(id.publicKey, dek);
    const aad = enc("scope-1|content|logical-42");
    const blob = lc.seal(dek, enc("the raw conversation"), aad);

    // Escrow the identity secret under a passphrase (what lands server-side).
    const salt = lc.generateKdfSalt();
    const escrow = lc.wrapWithKek(
      lc.deriveKek("hunter2", salt, FAST),
      id.secretKey,
    );

    // Device 2 (fresh): pulls escrow + wrapped DEK + blob, enters the passphrase.
    const idSecret2 = lc.unwrapWithKek(
      lc.deriveKek("hunter2", salt, FAST),
      escrow,
    );
    const dek2 = await lc.unwrapDek(idSecret2, wrappedDek);
    expect(dec(lc.open(dek2, blob, aad))).toBe("the raw conversation");
  });
});
