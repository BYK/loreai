-- Migration 0012 — scope_keys.wrapped_dek is first-write-wins (#825 follow-up).
--
-- Defense-in-depth against a multi-device DEK clobber. scope_keys holds the per-scope
-- data-encryption key wrapped (HPKE) to a member's account key. RLS lets the owner
-- UPDATE their own row, so a second device that minted a DIVERGENT identity (via a bug,
-- a race, or a client that bypasses our bootstrap) could overwrite `wrapped_dek` with a
-- DEK wrapped to a DIFFERENT key — orphaning every ciphertext sealed under the original
-- DEK and locking the original device out (it would pull a DEK it cannot HPKE-unwrap).
--
-- The C-4b client bootstrap already pulls-before-mint to avoid this, but the server had
-- no durable guard. This one makes `wrapped_dek` immutable once written, PER key_epoch:
--   • allowed  — INSERT (first write); metadata-only UPDATEs that keep wrapped_dek
--                (updated_at/revision/content_hash/is_deleted); a genuine key ROTATION
--                (a strictly higher key_epoch may carry a new DEK — future work).
--   • blocked  — changing wrapped_dek at the same-or-lower key_epoch (the clobber),
--                raised as check_violation (23514) so the client classifies it "poison"
--                and drops the offending push, leaving the canonical DEK intact.
--
-- NON-GOAL: account_escrow stays mutable — a passphrase change legitimately re-wraps the
-- account secret and must sync. The rare simultaneous-first-setup race (two devices both
-- mint before either's scope_keys write propagates) can still leave the LWW escrow not
-- matching the FWW DEK, but no ciphertext is lost (the DEK winner stays fully functional)
-- and a device that pulled the mismatched escrow fails closed and recovers on re-sync. A
-- full escrow-consistency guard (claims/epochs) is future work (teams, #827).

-- SCOPE: this is UPDATE-scoped defense-in-depth against an ACCIDENTAL clobber by the
-- benign sync engine (which only ever writes key_epoch=0 and never hard-deletes
-- scope_keys), NOT a rollback-proof constraint. An owner acting directly against their
-- OWN RLS-scoped row could still bypass it (lower key_epoch first, or DELETE+INSERT) —
-- self-inflicted only, no cross-tenant reach. A fuller constraint lands with the
-- escrow-consistency work for teams (#827).
create or replace function public.guard_scope_key_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.wrapped_dek is distinct from old.wrapped_dek
     and new.key_epoch <= old.key_epoch then
    raise exception
      'scope_keys.wrapped_dek is immutable for key_epoch % (first-write-wins)',
      old.key_epoch
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Fires before scope_keys_row_quota / scope_keys_set_updated_at (name sorts first), so a
-- clobber is rejected before any quota accounting or updated_at bump.
drop trigger if exists scope_keys_guard_immutable on public.scope_keys;
create trigger scope_keys_guard_immutable
  before update on public.scope_keys
  for each row execute function public.guard_scope_key_immutable();
