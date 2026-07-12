-- Migration 0032 — pin the membership/role helper oracles to the SELF caller (E, #827).
--
-- 0023 defined is_member / is_org_member / scope_role / org_role as SECURITY DEFINER helpers
-- (they bypass RLS to avoid policy recursion) granted to `authenticated`, each with a 2-arg
-- (scope/org, p_uid) form. Because they bypass RLS, an authenticated client could pass an
-- ARBITRARY p_uid and probe whether any user belongs to / holds a role in a scope or org it is
-- NOT a member of — a roster / role-harvesting oracle over the entire tenant base. Harmless while
-- membership was self-rows only; load-bearing now that E-4 introduced cross-user membership and
-- E-5 is about to add invite/domain/GitHub provisioning.
--
-- Fix: mirror the shares_scope guard (0029) — a caller may only ask about ITSELF
-- (p_uid = auth.uid()); service_role (Stripe / server tasks) stays exempt. This is a pure body
-- change on the SAME signatures (CREATE OR REPLACE → same OID), so every RLS policy and grant is
-- untouched: RLS always calls the 1-arg form, whose p_uid DEFAULTS to auth.uid(), so the guard's
-- first predicate is false and the call is never pinned. A pinned boolean returns false; a pinned
-- role returns null — revealing nothing about another user. (The roster of a scope you DO belong
-- to remains readable via the scope_members RLS policy; this only closes cross-scope probing
-- through the definer helpers.)

create or replace function public.is_member(p_scope uuid, p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select case
    when p_uid is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role'
      then false
    else exists(select 1 from public.scope_members where scope_id = p_scope and user_id = p_uid)
  end;
$$;

create or replace function public.is_org_member(p_org uuid, p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select case
    when p_uid is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role'
      then false
    else exists(select 1 from public.org_members where org_id = p_org and user_id = p_uid)
  end;
$$;

create or replace function public.scope_role(p_scope uuid, p_uid uuid default auth.uid())
returns text language sql stable security definer set search_path = pg_catalog, public
as $$
  select case
    when p_uid is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role'
      then null
    else (select role from public.scope_members where scope_id = p_scope and user_id = p_uid)
  end;
$$;

create or replace function public.org_role(p_org uuid, p_uid uuid default auth.uid())
returns text language sql stable security definer set search_path = pg_catalog, public
as $$
  select case
    when p_uid is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role'
      then null
    else (select role from public.org_members where org_id = p_org and user_id = p_uid)
  end;
$$;
