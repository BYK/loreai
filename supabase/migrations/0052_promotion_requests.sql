-- Pending personal-to-team proposals need a server record so a different team account can review them.
create table if not exists public.promotion_requests (
  id               uuid primary key,
  scope_id         uuid not null references public.scopes(id) on delete cascade,
  logical_id       text not null check (length(logical_id) between 1 and 128),
  entry_version_id text not null check (length(entry_version_id) between 1 and 128),
  entry_version    integer not null check (entry_version >= 1),
  category         text not null check (length(category) between 1 and 64),
  title_enc        text not null check (length(title_enc) between 1 and 8192),
  content_enc      text not null check (length(content_enc) between 1 and 262144),
  proposer_id      uuid not null default auth.uid(),
  status           text not null default 'pending'
                     check (status in ('pending','approved','rejected','withdrawn')),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_note    text check (decision_note is null or length(decision_note) <= 500),
  applied          text check (applied is null or applied in ('applied','stale')),
  applied_at       timestamptz,
  created_at       timestamptz not null default now(),
  check (status in ('pending','withdrawn') or (decided_by is not null and decided_at is not null)),
  check (applied is null or status in ('approved','rejected'))
);
create unique index if not exists promotion_requests_one_pending
  on public.promotion_requests (scope_id, logical_id) where status = 'pending';
create index if not exists promotion_requests_scope_created
  on public.promotion_requests (scope_id, created_at desc);

create or replace function public.promotion_requests_stamp() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin new.created_at := now(); return new; end $$;
drop trigger if exists promotion_requests_stamp on public.promotion_requests;
create trigger promotion_requests_stamp before insert on public.promotion_requests
  for each row execute function public.promotion_requests_stamp();

alter table public.promotion_requests enable row level security;
revoke all on public.promotion_requests from anon;
revoke update, delete on public.promotion_requests from authenticated;
grant select, insert on public.promotion_requests to authenticated;
revoke insert on public.promotion_requests from authenticated;

drop policy if exists promotion_requests_select on public.promotion_requests;
create policy promotion_requests_select on public.promotion_requests
  for select to authenticated using (public.is_member(scope_id));
drop policy if exists promotion_requests_insert on public.promotion_requests;

create or replace function public.decide_promotion(p_id uuid, p_decision text, p_note text default null)
returns public.promotion_requests language plpgsql security definer set search_path = pg_catalog, public
as $$
declare r public.promotion_requests;
begin
  if p_decision is null or p_decision not in ('approved','rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'decision note too long' using errcode = '22001';
  end if;
  select * into r from public.promotion_requests where id = p_id for update;
  if not found or not public.is_member(r.scope_id) then
    raise exception 'promotion request not found' using errcode = 'P0002';
  end if;
  if public.scope_role(r.scope_id) is distinct from 'admin' then
    raise exception 'only a team admin may review promotions' using errcode = '42501';
  end if;
  if r.status <> 'pending' then
    raise exception 'promotion request already %', r.status using errcode = '55000';
  end if;
  update public.promotion_requests
     set status = p_decision, decided_by = auth.uid(), decided_at = now(), decision_note = p_note
   where id = p_id returning * into r;
  return r;
end $$;

create or replace function public.propose_promotion(
  p_id uuid,
  p_scope uuid,
  p_logical_id text,
  p_entry_version_id text,
  p_entry_version integer,
  p_category text,
  p_title_enc text,
  p_content_enc text
)
returns public.promotion_requests
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  r public.promotion_requests;
  v_policy text;
begin
  if public.scope_role(p_scope) is null
     or public.scope_role(p_scope) not in ('editor', 'admin')
     or not exists (select 1 from public.scopes s where s.id = p_scope and s.kind = 'team') then
    raise exception 'only team editors and admins may propose promotions' using errcode = '42501';
  end if;
  select coalesce(s.promotion_policy, 'manual') into v_policy
    from public.scopes s where s.id = p_scope;
  if not found then
    raise exception 'team scope not found' using errcode = '42501';
  end if;
  insert into public.promotion_requests (
    id, scope_id, logical_id, entry_version_id, entry_version, category,
    title_enc, content_enc, proposer_id, status, decided_by, decided_at, decision_note
  )
  values (
    p_id, p_scope, p_logical_id, p_entry_version_id, p_entry_version, p_category,
    p_title_enc, p_content_enc, auth.uid(),
    case when v_policy = 'auto' then 'approved' else 'pending' end,
    case when v_policy = 'auto' then auth.uid() else null end,
    case when v_policy = 'auto' then now() else null end,
    case when v_policy = 'auto' then 'auto-approved: team does not require review' else null end
  )
  returning * into r;
  return r;
end $$;

create or replace function public.set_team_promotion_policy(
  p_scope uuid,
  p_policy text,
  p_expected text
)
returns text
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_current text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_scope::text, 0));
  if public.scope_role(p_scope) is distinct from 'admin'
     or not exists (select 1 from public.scopes s where s.id = p_scope and s.kind = 'team') then
    raise exception 'only a team admin may change promotion policy' using errcode = '42501';
  end if;
  if p_policy is null or p_policy not in ('manual', 'auto') then
    raise exception 'promotion policy must be manual or auto' using errcode = '22023';
  end if;
  select coalesce(s.promotion_policy, 'manual') into v_current
    from public.scopes s where s.id = p_scope and s.kind = 'team' for update;
  if not found then
    raise exception 'team scope not found' using errcode = '42501';
  end if;
  if v_current is distinct from p_expected then
    raise exception 'promotion policy changed; expected %, found %', p_expected, v_current
      using errcode = '40001';
  end if;
  update public.scopes set promotion_policy = p_policy where id = p_scope;
  return p_policy;
end $$;

create or replace function public.withdraw_promotion(p_id uuid)
returns public.promotion_requests language plpgsql security definer set search_path = pg_catalog, public
as $$
declare r public.promotion_requests;
begin
  select * into r from public.promotion_requests where id = p_id for update;
  if not found or not public.is_member(r.scope_id) then
    raise exception 'promotion request not found' using errcode = 'P0002';
  end if;
  if r.proposer_id is distinct from auth.uid() then
    raise exception 'only the proposer may withdraw a promotion' using errcode = '42501';
  end if;
  if r.status <> 'pending' then
    raise exception 'promotion request already %', r.status using errcode = '55000';
  end if;
  update public.promotion_requests set status = 'withdrawn' where id = p_id returning * into r;
  return r;
end $$;

create or replace function public.mark_promotion_applied(p_id uuid, p_outcome text)
returns public.promotion_requests language plpgsql security definer set search_path = pg_catalog, public
as $$
declare r public.promotion_requests;
begin
  if p_outcome is null or p_outcome not in ('applied','stale') then
    raise exception 'outcome must be applied or stale' using errcode = '22023';
  end if;
  select * into r from public.promotion_requests where id = p_id for update;
  if not found or not public.is_member(r.scope_id) then
    raise exception 'promotion request not found' using errcode = 'P0002';
  end if;
  if r.proposer_id is distinct from auth.uid() then
    raise exception 'only the proposer may record the outcome' using errcode = '42501';
  end if;
  if r.status not in ('approved','rejected') or r.applied is not null then
    raise exception 'promotion outcome cannot be recorded in state %', r.status using errcode = '55000';
  end if;
  update public.promotion_requests set applied = p_outcome, applied_at = now()
   where id = p_id returning * into r;
  return r;
end $$;

revoke all on function public.decide_promotion(uuid, text, text) from public, anon;
revoke all on function public.propose_promotion(uuid, uuid, text, text, integer, text, text, text) from public, anon;
revoke all on function public.set_team_promotion_policy(uuid, text, text) from public, anon;
revoke all on function public.withdraw_promotion(uuid) from public, anon;
revoke all on function public.mark_promotion_applied(uuid, text) from public, anon;
grant execute on function public.decide_promotion(uuid, text, text) to authenticated;
grant execute on function public.propose_promotion(uuid, uuid, text, text, integer, text, text, text) to authenticated;
grant execute on function public.set_team_promotion_policy(uuid, text, text) to authenticated;
grant execute on function public.withdraw_promotion(uuid) to authenticated;
grant execute on function public.mark_promotion_applied(uuid, text) to authenticated;
