-- Migration 0045 — domain auto-join (Model B: verified-admin-email claim + freemail blocklist +
-- approve-on-join) (E-5-b, #827).
--
-- An org admin/manager may CLAIM an auto-join domain ONLY if their OWN email is verified and at that
-- domain, and the domain is not a public/freemail domain. A user whose VERIFIED email matches a
-- claimed domain may REQUEST to join; an org admin approves (additive, never demote). No silent
-- absorption (that is Model A / DNS-TXT, a later upgrade) and no pure email-match hijack.

-- ---------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------
create table if not exists public.org_domains (
  org_id           uuid not null references public.orgs (id) on delete cascade,
  domain           text not null,                     -- lowercased; the claimant admin's verified domain
  claimed_by       uuid not null references auth.users (id) on delete cascade,
  join_role        text not null default 'member' check (join_role in ('manager', 'billing', 'member')),
  requires_approval boolean not null default true,    -- Model B: always true here (DNS-TXT relaxes later)
  created_at       timestamptz not null default now(),
  primary key (org_id, domain)
);

create table if not exists public.domain_join_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  domain       text not null,
  user_id      uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_by   uuid references auth.users (id),
  decided_at   timestamptz,
  unique (org_id, user_id)                             -- one live request per (org, user)
);
create index if not exists idx_domain_join_requests_org on public.domain_join_requests (org_id);

-- ---------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------
-- The raw (UNGUARDED) verified-email domain of any user. NOT granted to authenticated — it exists so
-- the admin-gated approve_domain_join RPC (SECURITY DEFINER) can re-verify a DIFFERENT user's email
-- domain at approval time without tripping email_domain()'s self-only oracle guard. Only reachable
-- from inside definer functions in this schema (no direct client grant). Defined BEFORE email_domain
-- since email_domain's SQL body references it.
create or replace function public.verified_email_domain(p_uid uuid)
returns text language sql stable security definer set search_path = pg_catalog, public
as $$
  select lower(split_part(u.email, '@', 2))
    from auth.users u
    where u.id = p_uid
      and u.email is not null
      and u.email_confirmed_at is not null
      and position('@' in u.email) > 0;
$$;
-- Postgres grants EXECUTE to PUBLIC by default at CREATE time, and PostgREST exposes any executable
-- function at /rest/v1/rpc/<name> (the 0039 hazard). This helper is UNGUARDED (no self-only oracle
-- pin) — it must NEVER be client-callable, or any authenticated user could read any user's verified
-- email domain. Revoke the blanket PUBLIC/anon grants so it is reachable ONLY from inside the
-- admin-gated definer RPCs in this schema.
revoke all on function public.verified_email_domain(uuid) from public, anon, authenticated;

-- The lowercased domain of a user's VERIFIED email, or NULL if unset/unconfirmed. Self-only: a
-- cross-user probe (p_uid <> auth.uid()) returns NULL unless the caller is service_role — mirrors the
-- 0032 oracle-guard pins so this can never be used to learn another user's email domain.
create or replace function public.email_domain(p_uid uuid default auth.uid())
returns text language sql stable security definer set search_path = pg_catalog, public
as $$
  select case
    when p_uid is distinct from auth.uid() and auth.role() is distinct from 'service_role' then null
    else public.verified_email_domain(p_uid)
  end;
$$;
grant execute on function public.email_domain(uuid) to authenticated;

-- Public/freemail domains that no single org may claim (they are shared by unrelated people).
create or replace function public.is_freemail(p_domain text)
returns boolean language sql immutable set search_path = pg_catalog, public
as $$
  select lower(p_domain) in (
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
    'pm.me', 'aol.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'mail.com', 'fastmail.com',
    'hey.com', 'tutanota.com', 'tuta.io', 'qq.com', '163.com', '126.com'
  );
$$;
grant execute on function public.is_freemail(text) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- RPCs (SECURITY DEFINER, pinned search_path, org-locked)
-- ---------------------------------------------------------------------------------------------------
-- Claim an auto-join domain for an org. Admin/manager-only; the claimant must PROVE control by having
-- their own VERIFIED email at the domain; freemail domains are rejected.
create or replace function public.claim_org_domain(
  p_org uuid, p_domain text, p_join_role text default 'member')
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_domain text := lower(trim(p_domain));
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 0));
  if coalesce(public.org_role(p_org), '') not in ('owner', 'manager') then
    raise exception 'only an org owner/manager may claim a domain' using errcode = '42501';
  end if;
  if p_join_role not in ('manager', 'billing', 'member') then
    raise exception 'join role must be manager/billing/member' using errcode = '22023';
  end if;
  if v_domain = '' or position('@' in v_domain) > 0 or position('.' in v_domain) = 0 then
    raise exception 'invalid domain' using errcode = '22023';
  end if;
  if public.is_freemail(v_domain) then
    raise exception 'public/freemail domains cannot be claimed' using errcode = '22023';
  end if;
  -- Proof of control: the claiming admin's OWN verified email must be at this domain.
  if public.email_domain(auth.uid()) is distinct from v_domain then
    raise exception 'your verified email must be at the claimed domain' using errcode = '42501';
  end if;
  insert into public.org_domains (org_id, domain, claimed_by, join_role)
    values (p_org, v_domain, auth.uid(), p_join_role)
    on conflict (org_id, domain) do update set join_role = excluded.join_role;
end $$;
grant execute on function public.claim_org_domain(uuid, text, text) to authenticated;

-- Request to join an org whose claimed domain matches the caller's VERIFIED email. Identical error
-- for "no such claim" and "email does not match" so a claimed-domain list can't be enumerated.
create or replace function public.request_domain_join(p_org uuid, p_domain text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_domain text := lower(trim(p_domain)); v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 0));
  if not exists (select 1 from public.org_domains where org_id = p_org and domain = v_domain)
     or public.email_domain(auth.uid()) is distinct from v_domain then
    raise exception 'no matching claimed domain for your verified email' using errcode = '42501';
  end if;
  -- Already a member? Nothing to request.
  if public.is_org_member(p_org) then
    raise exception 'already a member of this org' using errcode = '22023';
  end if;
  insert into public.domain_join_requests (org_id, domain, user_id)
    values (p_org, v_domain, auth.uid())
    on conflict (org_id, user_id) do update set
      status = 'pending', domain = excluded.domain, requested_at = now(),
      decided_by = null, decided_at = null
    returning id into v_id;
  return v_id;
end $$;
grant execute on function public.request_domain_join(uuid, text) to authenticated;

-- Approve a pending join request. Org admin/manager-only. Additive (never downgrades an existing
-- higher role). Re-verifies the requester's email STILL matches the claimed domain at approval time
-- (guards against an email change between request and approval).
create or replace function public.approve_domain_join(p_request_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare rec public.domain_join_requests%rowtype;
begin
  select * into rec from public.domain_join_requests where id = p_request_id;
  if not found then
    raise exception 'no such request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(rec.org_id::text, 0));
  -- Re-read under the lock (mirrors accept_scope_invite's discipline): a concurrent approval that
  -- won the lock first may have already decided this request, so the stale pre-lock rec.status must
  -- not be trusted for the 'pending' check / audit stamp below.
  select * into rec from public.domain_join_requests where id = p_request_id;
  if not found then
    raise exception 'no such request' using errcode = '22023';
  end if;
  if coalesce(public.org_role(rec.org_id), '') not in ('owner', 'manager') then
    raise exception 'only an org owner/manager may approve join requests' using errcode = '42501';
  end if;
  if rec.status <> 'pending' then
    raise exception 'request already decided' using errcode = '22023';
  end if;
  -- The claim must still exist AND the requester's verified email must still match it. Use the
  -- UNGUARDED verified_email_domain (this RPC is already admin-gated) — email_domain() would return
  -- NULL for a cross-user (requester ≠ approving admin) probe.
  if not exists (select 1 from public.org_domains where org_id = rec.org_id and domain = rec.domain)
     or public.verified_email_domain(rec.user_id) is distinct from rec.domain then
    raise exception 'requester no longer qualifies for this domain' using errcode = '22023';
  end if;
  insert into public.org_members (org_id, user_id, role)
    select rec.org_id, rec.user_id, coalesce(d.join_role, 'member')
      from public.org_domains d where d.org_id = rec.org_id and d.domain = rec.domain
    on conflict (org_id, user_id) do nothing;   -- additive: never downgrade an existing role
  update public.domain_join_requests
    set status = 'approved', decided_by = auth.uid(), decided_at = now()
    where id = p_request_id;
end $$;
grant execute on function public.approve_domain_join(uuid) to authenticated;

create or replace function public.reject_domain_join(p_request_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare rec public.domain_join_requests%rowtype;
begin
  select * into rec from public.domain_join_requests where id = p_request_id;
  if not found then
    raise exception 'no such request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(rec.org_id::text, 0));
  if coalesce(public.org_role(rec.org_id), '') not in ('owner', 'manager') then
    raise exception 'only an org owner/manager may reject join requests' using errcode = '42501';
  end if;
  update public.domain_join_requests
    set status = 'rejected', decided_by = auth.uid(), decided_at = now()
    where id = p_request_id and status = 'pending';
end $$;
grant execute on function public.reject_domain_join(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- RLS — both tables written ONLY via the RPCs above; reads scoped so a member/admin sees the relevant
-- rows. No direct DML grant to authenticated (RPC-only), matching pending_invites.
-- ---------------------------------------------------------------------------------------------------
alter table public.org_domains enable row level security;
revoke all on public.org_domains from anon, authenticated;
grant select on public.org_domains to authenticated;   -- reads only; writes are RPC-only (RLS scopes rows)
drop policy if exists org_domains_read on public.org_domains;
create policy org_domains_read on public.org_domains
  for select using (public.is_org_member(org_id));   -- org members may see their org's claimed domains

alter table public.domain_join_requests enable row level security;
revoke all on public.domain_join_requests from anon, authenticated;
grant select on public.domain_join_requests to authenticated;   -- reads only; writes are RPC-only
drop policy if exists domain_join_requests_read on public.domain_join_requests;
create policy domain_join_requests_read on public.domain_join_requests
  for select using (
    user_id = (select auth.uid())                                   -- a user sees their own request
    or coalesce(public.org_role(org_id), '') in ('owner', 'manager')-- an admin sees their org's requests
  );
