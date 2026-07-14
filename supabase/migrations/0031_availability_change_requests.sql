-- Employee availability changes now require manager approval. An employee
-- editing their typical-week availability files a change request here instead
-- of writing to `availability` directly; the row is applied to `availability`
-- only when a manager approves it. Managers editing an employee's availability
-- still write directly (their approval is implicit).
--
-- Requested state per day:
--   requested_clear = true                  -> remove the day's restriction ("any time")
--   start/end null (clear = false)          -> unavailable all day ("off")
--   start/end set  (clear = false)          -> availability window
--
-- Mirrors the callouts multitenancy shape: org_id column, composite FK so a
-- row's org must match its employee's org, member-writable is_org_member RLS
-- (fine-grained "own request only" rules live in the API), and Realtime
-- publication so manager request badges update live.

begin;

create table if not exists public.availability_change_requests (
  id                      bigint generated always as identity primary key,
  org_id                  uuid    not null references public.organizations (id),
  employee_id             bigint  not null,
  day_of_week             int     not null check (day_of_week between 0 and 6),
  requested_start_minutes int,
  requested_end_minutes   int,
  requested_note          text,
  requested_clear         boolean not null default false,
  status                  text    not null default 'pending'
                          check (status in ('pending', 'approved', 'denied')),
  created_by              uuid,
  decided_by              uuid,
  decided_at              timestamptz,
  created_at              timestamptz not null default now(),
  constraint availability_change_requests_employee_org_fkey
    foreign key (employee_id, org_id) references public.employees (id, org_id)
);

-- A new request for the same day replaces the pending one (the API deletes it
-- first); this index is the backstop that keeps at most one pending per day.
create unique index if not exists availability_change_requests_pending_uniq
  on public.availability_change_requests (org_id, employee_id, day_of_week)
  where status = 'pending';

create index if not exists availability_change_requests_org_status_idx
  on public.availability_change_requests (org_id, status);

-- ---------------------------------------------------------------------------
-- Row Level Security — member-writable, identical to availability/callouts.
-- ---------------------------------------------------------------------------
alter table public.availability_change_requests enable row level security;

drop policy if exists mt_select on public.availability_change_requests;
create policy mt_select on public.availability_change_requests
  for select using (public.is_org_member(org_id));

drop policy if exists mt_write on public.availability_change_requests;
create policy mt_write on public.availability_change_requests
  for all using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Demo reset — fold the new table into reset_demo_org(). Redefines the 0015
-- version with one added DELETE (before employees; the composite org FK has
-- no ON DELETE CASCADE).
-- ---------------------------------------------------------------------------
create or replace function public.reset_demo_org(p_org uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from organizations where id = p_org and is_demo) then
    raise exception 'reset_demo_org: % is not a demo organization', p_org;
  end if;

  delete from open_shift_claims      where org_id = p_org;
  delete from open_shifts            where org_id = p_org;
  delete from punch_records          where org_id = p_org;
  delete from shift_swaps            where org_id = p_org;
  delete from draft_schedules        where org_id = p_org;
  delete from schedule_template_rows where org_id = p_org;
  delete from schedule_templates     where org_id = p_org;
  delete from schedules              where org_id = p_org;
  delete from availability_change_requests where org_id = p_org;
  delete from availability           where org_id = p_org;
  delete from time_off_requests      where org_id = p_org;
  delete from callouts               where org_id = p_org;
  delete from messages               where org_id = p_org;
  delete from notifications          where org_id = p_org;
  delete from audit_logs             where org_id = p_org;
  delete from coverage_profile_blocks where org_id = p_org;
  delete from coverage_date_overrides where org_id = p_org;
  delete from coverage_day_defaults  where org_id = p_org;
  delete from coverage_profiles      where org_id = p_org;
  delete from store_hours            where org_id = p_org;
  delete from app_settings           where org_id = p_org;
  delete from employees              where org_id = p_org;
  delete from managers               where org_id = p_org;
end;
$$;

revoke all on function public.reset_demo_org(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime — manager request badges and employee pending markers update live.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = 'availability_change_requests'
    ) then
      execute 'alter publication supabase_realtime add table public.availability_change_requests';
    end if;
  end if;
end $$;

commit;
