-- Migration 0030 — key rotation foundation: multi-epoch scope_keys + atomic epoch (E-4c-3a, #827).
--
-- Rotate-on-remove needs the scope's DEK to change so a removed member cannot read FUTURE writes,
-- while REMAINING members (and fresh devices / re-syncs) can still read PAST blobs. Each blob's
-- envelope pins its key_epoch (crypto/envelope.ts), so every epoch's DEK must remain retrievable.
--
-- (A) MULTI-EPOCH scope_keys: the PK gains key_epoch, so a member accumulates one wrap PER epoch
--     (the originator wraps the fresh DEK to each remaining member at N+1; old-epoch rows stay).
-- (3) SERVER-ATOMIC epoch: scopes.key_epoch is the counter; rotate_scope_key() bumps it under a
--     row lock so concurrent admins can never both mint the same N+1 with divergent DEKs.
--
-- 3a is the SCHEMA + atomic-counter + immutability foundation only. The client rotation crypto
-- (mint fresh DEK, wrap to remaining members, epoch-aware seal/open) is E-4c-3b; no new-epoch row
-- is created until then, so the enforce_row_quota per-epoch probe fix rides with 3b (unreachable
-- here). rotate_scope_key exists now (Tier-1 testable) as the atomic primitive 3b/E-4c-4 call.

-- Retain a wrap row per (scope, member, EPOCH) instead of one per (scope, member).
alter table public.scope_keys
  drop constraint scope_keys_pkey,
  add primary key (scope_id, member_user_id, key_epoch);

-- The scope's current key epoch — the atomic rotation counter (personal scopes stay at 0).
alter table public.scopes add column if not exists key_epoch integer not null default 0;

-- Atomically allocate the next epoch for a scope. Admin-only. The UPDATE takes a row lock, so two
-- concurrent callers serialize and receive DISTINCT epochs — never a dueling N+1 with two DEKs.
create or replace function public.rotate_scope_key(p_scope uuid)
returns integer language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_epoch integer;
begin
  if public.scope_role(p_scope) is distinct from 'admin' then
    raise exception 'only a scope admin may rotate the key' using errcode = '42501';
  end if;
  update public.scopes set key_epoch = key_epoch + 1 where id = p_scope
    returning key_epoch into v_epoch;
  if v_epoch is null then
    raise exception 'no such scope' using errcode = '23503';
  end if;
  return v_epoch;
end $$;

grant execute on function public.rotate_scope_key(uuid) to authenticated;

-- Immutability for the multi-epoch model: an existing (scope, member, epoch) row's wrapped_dek is
-- IMMUTABLE — a rotation writes a NEW epoch row (INSERT), never an in-place re-wrap. Any UPDATE
-- that changes wrapped_dek is therefore a clobber → 23514 poison (the client drops that push, the
-- canonical wrap survives). Metadata-only UPDATEs (updated_at / revision / content_hash /
-- is_deleted) are still allowed. Supersedes the pre-rotation epoch-comparison guard (0012), which
-- assumed the single-row model where rotation was an in-place key_epoch bump.
create or replace function public.guard_scope_key_immutable()
returns trigger language plpgsql
as $$
begin
  if new.wrapped_dek is distinct from old.wrapped_dek then
    raise exception
      'scope_keys.wrapped_dek is immutable for key_epoch % (rotation writes a new epoch row)',
      old.key_epoch
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
