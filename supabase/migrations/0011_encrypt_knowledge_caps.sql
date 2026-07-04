-- Migration 0011 — widen the free-tier knowledge byte cap for wire encryption (C-4, #825).
--
-- Client-side encryption (C-4) seals knowledge.content + knowledge.title to a per-scope
-- DEK and stores them as base64(envelope) on the wire. That inflates those columns by
-- the envelope header + AEAD tag (~63 bytes/column) and base64 (~1.37×), so a library
-- that fit under the 8 MB free cap in plaintext could tip over once encrypted. Bump the
-- free knowledge byte cap to 12 MB (~1.5×) to preserve the same effective capacity.
--
-- Only the FREE tier carries byte caps (0007 set max_bytes for tier='free' only; pro's
-- max_bytes is NULL = uncapped), so this is the only row that needs adjusting. Row caps
-- are unchanged (encryption doesn't add rows). Idempotent.

update public.plan_limits
   set max_bytes = 12582912   -- 12 MB (was 8 MB)
 where tier = 'free' and table_name = 'knowledge';

-- Per-row size CHECK: base64(envelope) inflates content/title ~1.37× + ~63 bytes of
-- envelope header/tag, so the 0004 caps (title 512, content 8192) would reject an
-- encrypted row that fit in plaintext — a check_violation is classified "poison" and
-- silently dropped from sync. Widen title 512→1024 and content 8192→12288 (~1.5×) to
-- cover the ciphertext of a max-plaintext entry. All other bounds are unchanged from
-- 0004 (a drop+re-add must restate the whole constraint). Idempotent.
alter table public.knowledge drop constraint if exists knowledge_size_ck;
alter table public.knowledge add constraint knowledge_size_ck check (
  length(title) <= 1024
  and length(content) <= 12288
  and length(category) <= 64
  and (metadata is null or length(metadata) <= 8192)
  and (project_id is null or length(project_id) <= 1024)
  and (source_session is null or length(source_session) <= 256)
  and (created_by is null or length(created_by) <= 256)
  and (updated_by is null or length(updated_by) <= 256)
  and (sensitivity is null or length(sensitivity) <= 32)
  and (promotion_status is null or length(promotion_status) <= 32)
  and (content_hash is null or length(content_hash) <= 64)
);
