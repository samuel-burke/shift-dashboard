-- Job codes and weekly-hours preferences.
--
-- Two related pieces:
--   * employees.job_code — full_time | part_time, a manager-set employment
--     classification. Full-time always means 40 hours/week (the app never
--     stores a preference for them); part-time associates choose their own
--     target. Lives on employees because it is manager-controlled: the
--     employees table already restricts writes to managers.
--   * work_preferences — a part-time associate's preferred weekly hours.
--     Its own member-writable table (mirroring availability/callouts) because
--     employees must be able to set their own preference, and employees-table
--     RLS would let a self-writing employee touch manager-only columns like
--     pay_rate. Fine-grained rules ("only your own row, or a manager") stay
--     enforced in the API layer; RLS is the tenant-isolation backstop.
--
-- The employee FK cascades on delete, so removing an employee (including via
-- reset_demo_org's nightly demo wipe) cleans up their preference row without
-- redefining that function.

begin;

alter table public.employees
  add column if not exists job_code text not null default 'part_time';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'employees_job_code_check'
  ) then
    alter table public.employees
      add constraint employees_job_code_check
      check (job_code in ('full_time', 'part_time'));
  end if;
end $$;

create table if not exists public.work_preferences (
  id              bigint generated always as identity primary key,
  org_id          uuid   not null references public.organizations (id),
  employee_id     bigint not null,
  -- Weekly hours the associate wants to work. Bounds match the app-layer
  -- validation in lib/work-preference.ts.
  preferred_hours integer not null check (preferred_hours between 1 and 40),
  updated_at      timestamptz not null default now(),
  -- One preference per employee.
  unique (org_id, employee_id),
  -- The preference's org must match its employee's org (employees has an
  -- (id, org_id) unique key from 0002_multitenancy_enforce.sql).
  constraint work_preferences_employee_org_fkey
    foreign key (employee_id, org_id) references public.employees (id, org_id)
    on delete cascade
);

create index if not exists work_preferences_org_employee_idx
  on public.work_preferences (org_id, employee_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — member-writable, identical to availability/callouts.
-- ---------------------------------------------------------------------------
alter table public.work_preferences enable row level security;

drop policy if exists mt_select on public.work_preferences;
create policy mt_select on public.work_preferences
  for select using (public.is_org_member(org_id));

drop policy if exists mt_write on public.work_preferences;
create policy mt_write on public.work_preferences
  for all using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

commit;
