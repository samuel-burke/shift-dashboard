-- Auto schedule generation migration
-- Run this in the Supabase SQL editor before using Auto-fill on the /draft page.

-- 1. Draft shifts remember where they came from. Manager-placed (or
--    manager-edited) shifts are 'manual' and are never touched by the
--    generator; 'auto' shifts are regenerated whenever their inputs change
--    (coverage curves, availability, approved time off, call-outs).
alter table draft_schedules
  add column if not exists source text not null default 'manual'
  check (source in ('manual', 'auto'));

-- 2. Desired weekly hours per employee — a soft target the generator aims
--    for when distributing shifts. Null = no preference.
alter table employees
  add column if not exists desired_hours integer
  check (desired_hours is null or (desired_hours >= 0 and desired_hours <= 80));
