-- Migration 0033 — make the org/scope registry pull-syncable (E-5 foundation, #827).
--
-- The client needs a local, read-only mirror of WHICH orgs/scopes it belongs to (and co-members'
-- roles) so it can discover team scopes, unwrap their group DEK, and pull+decrypt their content.
-- That mirror is a pull-only SYNCED_TABLES entry, and the sync engine's pull cursor keysets on
-- (updated_at, id) — but the 0023 registry tables only have created_at. Add a server-stamped
-- updated_at to all four so a role change (set_scope_role) or membership change re-pulls.
--
-- These tables are written ONLY by SECURITY DEFINER paths (provisioning trigger + lifecycle RPCs),
-- never by a client push, so `default now()` covers INSERT and a BEFORE UPDATE trigger (the shared
-- sync_set_updated_at, as used by projects/keystore) covers mutations. RLS (0023) already scopes
-- reads to the member (orgs_read/scopes_read via is_*member, *_members_read via self/is_member) and
-- SELECT is already granted to authenticated — so the pull needs no policy/grant change.

alter table public.orgs
  add column if not exists updated_at timestamptz not null default now();
alter table public.org_members
  add column if not exists updated_at timestamptz not null default now();
alter table public.scopes
  add column if not exists updated_at timestamptz not null default now();
alter table public.scope_members
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists orgs_set_updated_at on public.orgs;
create trigger orgs_set_updated_at before update on public.orgs
  for each row execute function public.sync_set_updated_at();

drop trigger if exists org_members_set_updated_at on public.org_members;
create trigger org_members_set_updated_at before update on public.org_members
  for each row execute function public.sync_set_updated_at();

drop trigger if exists scopes_set_updated_at on public.scopes;
create trigger scopes_set_updated_at before update on public.scopes
  for each row execute function public.sync_set_updated_at();

drop trigger if exists scope_members_set_updated_at on public.scope_members;
create trigger scope_members_set_updated_at before update on public.scope_members
  for each row execute function public.sync_set_updated_at();
