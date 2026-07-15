-- 0041_encrypt_entities_caps.sql
-- Widen the entity-graph byte caps for wire encryption (C-4, #825).
--
-- Client-side encryption now seals the PII-bearing entity columns to a per-scope
-- DEK and stores them as base64(envelope) on the wire (like knowledge.content in
-- 0011):
--   entities:         canonical_name, metadata
--   entity_aliases:   alias_value
--   entity_relations: relation, metadata
--
-- base64(envelope) inflates each sealed column: the envelope adds a fixed 47 bytes
-- (31-byte header + 16-byte Poly1305 tag; XChaCha20 is a stream cipher so ciphertext
-- length == plaintext length), then base64 expands ~4/3. CRUCIALLY, the old 0004 caps
-- counted CHARACTERS (Postgres length() on text), but a UTF-8 char is up to 4 BYTES, so
-- a value that fit the old char-limit could be up to 4× larger in bytes. To guarantee
-- NO value that synced before gets poison-dropped now (a check_violation is classified
-- "poison" and silently dropped from sync), size each sealed bound to the WORST CASE:
--   ceil((old_chars * 4 + 47) / 3) * 4, rounded up.
--     canonical_name  512  chars -> 2796  -> 3072
--     alias_value     512  chars -> 2796  -> 3072
--     relation        128  chars -> 748   -> 1024
--     metadata        8192 chars -> 43756 -> 45056
-- Generous per-row bounds are fine — the free-tier max_bytes AGGREGATE cap (below) is
-- the real volume guard; these per-row CHECKs only reject pathological single values.
--
-- Only the SEALED columns' bounds change; every other bound is restated verbatim from
-- 0004. Cleartext columns (entity_type, alias_type, source, ids, project_id,
-- content_hash) are unchanged. Row caps are unchanged (encryption adds no rows).
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 1. Per-row size CHECK constraints (restated from 0004, sealed bounds widened
--    to the worst-case ciphertext of the OLD character limit).
-- ---------------------------------------------------------------------------
alter table public.entities drop constraint if exists entities_size_ck;
alter table public.entities add constraint entities_size_ck check (
  length(canonical_name) <= 3072                                 -- 512 chars → 3072 (sealed)
  and length(entity_type) <= 64
  and (metadata is null or length(metadata) <= 45056)            -- 8192 chars → 45056 (sealed)
  and (project_id is null or length(project_id) <= 1024)
  and (content_hash is null or length(content_hash) <= 64)
);

alter table public.entity_aliases drop constraint if exists entity_aliases_size_ck;
alter table public.entity_aliases add constraint entity_aliases_size_ck check (
  length(alias_value) <= 3072                                    -- 512 chars → 3072 (sealed)
  and length(alias_type) <= 64
  and length(entity_id) <= 64
  and (source is null or length(source) <= 256)
  and (content_hash is null or length(content_hash) <= 64)
);

alter table public.entity_relations drop constraint if exists entity_relations_size_ck;
alter table public.entity_relations add constraint entity_relations_size_ck check (
  length(relation) <= 1024                                       -- 128 chars → 1024 (sealed)
  and length(entity_a) <= 64
  and length(entity_b) <= 64
  and (source is null or length(source) <= 256)
  and (metadata is null or length(metadata) <= 45056)            -- 8192 chars → 45056 (sealed)
  and (content_hash is null or length(content_hash) <= 64)
);

-- ---------------------------------------------------------------------------
-- 2. Free-tier max_bytes (per-scope AGGREGATE). Only the FREE tier carries byte
--    caps (0007 set them for tier='free' only; pro's max_bytes is NULL =
--    uncapped). Bump ~1.5× to preserve effective capacity for typical (mostly-
--    ASCII) entity data post-encrypt. Unlike the per-row CHECK above, hitting
--    this aggregate cap only PAUSES the table's sync (recoverable) — it is a
--    volume guard, not a per-value correctness gate — so a 1.5× bump is the right
--    tradeoff (a 4× worst-case bump would balloon the free storage allowance).
-- ---------------------------------------------------------------------------
update public.plan_limits set max_bytes = v.max_bytes
  from (values
    ('entities',          1572864::bigint),   -- 1 MB   → 1.5 MB
    ('entity_aliases',    3145728::bigint),   -- 2 MB   → 3 MB
    ('entity_relations',  3145728::bigint)    -- 2 MB   → 3 MB
  ) as v(table_name, max_bytes)
 where public.plan_limits.tier = 'free'
   and public.plan_limits.table_name = v.table_name;
