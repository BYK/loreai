-- Migration 0047 — team-org ownership survives its provisioner's account deletion (#1314 part 1,
-- E-5-a durability). Pre-GA gate before any content lands in a team scope.
--
-- Problem: `orgs.owner_user_id` was `NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`. For a
-- PERSONAL org that cascade is correct (deleting a user removes their own org → scope → content).
-- But for a TEAM org, `owner_user_id` is NOT an authz axis (all gates use is_org_member/org_role/
-- scope_role) — it is just the arbitrary first provisioner (a plain GitHub member for a mirrored
-- org, or the create_team caller). If THAT user deletes their account, the whole team org → all its
-- scopes → all team content cascade-delete FOR EVERY OTHER MEMBER. That is a data-loss footgun.
--
-- Fix: detach a team org from its owner on user deletion instead of cascading.
--   1. `owner_user_id` becomes NULLABLE and the FK becomes `ON DELETE SET NULL` — so deleting a
--      user leaves their team orgs intact (owner_user_id → NULL; the org, scopes, and content
--      survive for the remaining members).
--   2. A `BEFORE DELETE ON auth.users` trigger still HARD-DELETES that user's PERSONAL org first
--      (its unique 1:1 owner), which cascades to the personal scope + content — preserving the
--      prior, correct personal-data-removal behavior. The trigger runs before the FK's SET NULL, so
--      only team orgs reach the SET NULL path.
--
-- Invariants preserved: the unique partial index `(owner_user_id) WHERE kind='personal'` still holds
-- (a detached team org has NULL owner, excluded from that index). RLS/gates never read owner_user_id
-- for access, so a NULL team owner changes no authz outcome.

-- ---------------------------------------------------------------------------------------------------
-- 1. Nullable owner + ON DELETE SET NULL
-- ---------------------------------------------------------------------------------------------------
alter table public.orgs alter column owner_user_id drop not null;

alter table public.orgs drop constraint if exists orgs_owner_user_id_fkey;
alter table public.orgs
  add constraint orgs_owner_user_id_fkey
  foreign key (owner_user_id) references auth.users (id) on delete set null;

-- ---------------------------------------------------------------------------------------------------
-- 2. Personal orgs still cascade-delete on user deletion (team orgs are left for SET NULL)
-- ---------------------------------------------------------------------------------------------------
-- SECURITY DEFINER: fires as part of an auth.users delete (admin/service path); it only ever deletes
-- rows the leaving user OWNS as a PERSONAL org, so it cannot touch another tenant's data. search_path
-- pinned to public (definer-safety: never resolve an object from a caller-controlled schema).
create or replace function public.delete_personal_org_on_user_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.orgs where kind = 'personal' and owner_user_id = old.id;
  return old;
end $$;

drop trigger if exists delete_personal_org_on_user_delete on auth.users;
create trigger delete_personal_org_on_user_delete
  before delete on auth.users
  for each row execute function public.delete_personal_org_on_user_delete();
