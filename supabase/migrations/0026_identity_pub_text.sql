-- Migration 0026 — identity_pub.public_key is base64 TEXT, not bytea (E-3b, #827).
--
-- The wire convention for ALL key material is base64 text (scope_keys.wrapped_dek,
-- account_escrow.wrapped_secret are text; the push base64-encodes local Uint8Array key
-- blobs). A member's published public key must follow the same convention so E-4's group
-- wrap reads it exactly like wrapped_dek (Buffer.from(value,'base64')) rather than as a
-- \x-hex bytea string — a silent-wrong-bytes footgun. identity_pub is empty (E-3b is the
-- first publisher), so the recast is trivial and lossless.
alter table public.identity_pub drop constraint if exists identity_pub_size_ck;
-- NOTE: the `type ... using` recast is single-run (a second apply would re-encode already-text
-- data and fail); safe because Supabase applies each migration exactly once via the ledger.
alter table public.identity_pub
  alter column public_key type text using encode(public_key, 'base64');
-- base64 of a ≤256-byte key is ≤344 chars; bound the text length with headroom (anti-abuse).
alter table public.identity_pub add constraint identity_pub_size_ck
  check (octet_length(public_key) <= 512);
