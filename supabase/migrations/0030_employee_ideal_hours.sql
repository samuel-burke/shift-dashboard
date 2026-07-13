-- Employee ideal weekly hours, a schedule preference managers can set (or
-- adjust) on an employee's behalf alongside their per-day availability.
--
-- Nullable; NULL means "no preference recorded". Whole hours per week,
-- validated to 0–168 in the API. No RLS change: employees already restricts
-- writes to managers and reads to org members.

begin;

alter table public.employees
  add column if not exists ideal_hours integer;

commit;
