// Server-side glue for automatic schedule generation. Loads the generator's
// inputs from the database, replaces the week's auto drafts, and keeps
// auto-managed weeks in sync when their inputs change (coverage curves,
// approved time off, call-outs).
//
// A week is "auto-managed" once a manager runs Auto-fill on it — from then on
// any input change re-runs the generator for that week until the drafts are
// published or deleted. Manual drafts (source = 'manual') are never touched:
// they stay fixed and the generator schedules around them.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateAutoSchedule, type FixedShift } from "./auto-schedule";
import { curveForDate, type CoverageBlock, type CoverageProfile } from "./coverage";
import { dayOfWeek, weekDates } from "./draft-metrics";
import { withOrgAll } from "./org-scope";

// Route handlers pass the client created by lib/supabase-server; keeping the
// parameter loosely typed (only `.from` is used) lets tests inject mocks.
type Db = Pick<SupabaseClient, "from">;

export type AutoSyncResult = {
  created: number;
  removed: number;
  unfilled: { date: string; startMinutes: number; endMinutes: number; shortfall: number }[];
};

const dateKey = (d: unknown) => (typeof d === "string" ? d.slice(0, 10) : String(d));

/**
 * Regenerate the auto drafts for one week. Manual drafts and already-published
 * shifts are treated as fixed; existing auto drafts are replaced wholesale.
 *
 * With `onlyIfAuto` (used by change hooks) the week is skipped unless it
 * already contains at least one auto draft — a week the manager hasn't
 * auto-filled is left alone.
 */
export async function syncAutoDraftsForWeek(
  supabase: Db,
  orgId: string,
  weekStart: string,
  { onlyIfAuto = false } = {}
): Promise<AutoSyncResult | null> {
  const dates = weekDates(weekStart);

  const { data: drafts, error: draftsError } = await supabase
    .from("draft_schedules")
    .select("id, employee_id, date, start_minutes, end_minutes, source")
    .eq("org_id", orgId)
    .gte("date", dates[0])
    .lte("date", dates[6]);
  if (draftsError) throw draftsError;

  const autoDrafts = (drafts ?? []).filter((d) => d.source === "auto");
  if (onlyIfAuto && autoDrafts.length === 0) return null;

  const [
    { data: employees, error: employeesError },
    { data: availability, error: availabilityError },
    { data: timeOff, error: timeOffError },
    { data: callouts, error: calloutsError },
    { data: published, error: publishedError },
    { data: profiles, error: profilesError },
    { data: blocks, error: blocksError },
    { data: dayDefaults, error: dayDefaultsError },
    { data: dateOverrides, error: dateOverridesError },
  ] = await Promise.all([
    supabase.from("employees").select("id, desired_hours").eq("org_id", orgId),
    supabase.from("availability").select("employee_id, day_of_week, start_minutes, end_minutes").eq("org_id", orgId),
    supabase.from("time_off_requests").select("employee_id, date").eq("org_id", orgId).eq("status", "approved").gte("date", dates[0]).lte("date", dates[6]),
    supabase.from("callouts").select("employee_id, date").eq("org_id", orgId).gte("date", dates[0]).lte("date", dates[6]),
    supabase.from("schedules").select("employee_id, date, start_minutes, end_minutes").eq("org_id", orgId).gte("date", dates[0]).lte("date", dates[6]),
    supabase.from("coverage_profiles").select("id").eq("org_id", orgId),
    supabase.from("coverage_profile_blocks").select("profile_id, start_minutes, end_minutes, headcount").eq("org_id", orgId).order("start_minutes"),
    supabase.from("coverage_day_defaults").select("day_of_week, profile_id").eq("org_id", orgId),
    supabase.from("coverage_date_overrides").select("date, profile_id").eq("org_id", orgId).gte("date", dates[0]).lte("date", dates[6]),
  ]);

  const loadError =
    employeesError ?? availabilityError ?? timeOffError ?? calloutsError ??
    publishedError ?? profilesError ?? blocksError ?? dayDefaultsError ?? dateOverridesError;
  if (loadError) throw loadError;

  const blocksByProfile = new Map<number, CoverageBlock[]>();
  for (const b of blocks ?? []) {
    if (!blocksByProfile.has(b.profile_id)) blocksByProfile.set(b.profile_id, []);
    blocksByProfile.get(b.profile_id)!.push({ startMinutes: b.start_minutes, endMinutes: b.end_minutes, headcount: b.headcount });
  }
  const coverageProfiles: CoverageProfile[] = (profiles ?? []).map((p) => ({
    id: p.id,
    name: "",
    blocks: blocksByProfile.get(p.id) ?? [],
  }));
  const defaults = Object.fromEntries((dayDefaults ?? []).map((d) => [d.day_of_week, d.profile_id]));
  const overrides = Object.fromEntries((dateOverrides ?? []).map((o) => [dateKey(o.date), o.profile_id]));
  const curves = Object.fromEntries(
    dates.map((d) => [d, curveForDate(d, overrides, defaults, coverageProfiles)])
  );

  const fixedShifts: FixedShift[] = [
    ...(drafts ?? [])
      .filter((d) => d.source !== "auto")
      .map((d) => ({ employeeId: d.employee_id, date: dateKey(d.date), startMinutes: d.start_minutes, endMinutes: d.end_minutes })),
    ...(published ?? [])
      .map((s) => ({ employeeId: s.employee_id, date: dateKey(s.date), startMinutes: s.start_minutes, endMinutes: s.end_minutes })),
  ];

  const { shifts, unfilled } = generateAutoSchedule({
    dates,
    curves,
    employees: (employees ?? []).map((e) => ({ id: e.id, desiredHours: e.desired_hours })),
    availability: (availability ?? []).map((a) => ({
      employeeId: a.employee_id,
      dayOfWeek: a.day_of_week,
      startMinutes: a.start_minutes,
      endMinutes: a.end_minutes,
    })),
    unavailableDates: [...(timeOff ?? []), ...(callouts ?? [])].map((r) => ({
      employeeId: r.employee_id,
      date: dateKey(r.date),
    })),
    fixedShifts,
  });

  if (autoDrafts.length > 0) {
    const { error: deleteError } = await supabase
      .from("draft_schedules")
      .delete()
      .eq("org_id", orgId)
      .in("id", autoDrafts.map((d) => d.id));
    if (deleteError) throw deleteError;
  }

  if (shifts.length > 0) {
    const { error: insertError } = await supabase
      .from("draft_schedules")
      .insert(withOrgAll(orgId, shifts.map((s) => ({
        employee_id:   s.employeeId,
        date:          s.date,
        start_minutes: s.startMinutes,
        end_minutes:   s.endMinutes,
        source:        "auto",
      }))));
    if (insertError) throw insertError;
  }

  return { created: shifts.length, removed: autoDrafts.length, unfilled };
}

/** Week start (YYYY-MM-DD) containing `date` for the org's first day of week. */
export function weekStartFor(date: string, firstDayOfWeek: number): string {
  const offset = (dayOfWeek(date) - firstDayOfWeek + 7) % 7;
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

// Safety valve: a runaway org with months of auto drafts still resyncs quickly.
const MAX_WEEKS_PER_SYNC = 12;

/**
 * Re-run generation for every auto-managed week affected by an input change.
 * `dates` narrows the sync to weeks containing those dates (e.g. a time-off
 * approval affects one day); omit it for org-wide changes like editing a
 * coverage profile or a day-of-week default.
 *
 * Only weeks from today onward that already contain auto drafts are touched.
 * Errors are swallowed by the caller pattern (`.catch`) — a failed resync
 * must never fail the mutation that triggered it.
 */
export async function resyncAutoDrafts(
  supabase: Db,
  orgId: string,
  { dates }: { dates?: string[] } = {}
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  const [{ data: autoDates, error: autoError }, { data: settings, error: settingsError }] = await Promise.all([
    supabase
      .from("draft_schedules")
      .select("date")
      .eq("org_id", orgId)
      .eq("source", "auto")
      .gte("date", today),
    supabase.from("app_settings").select("value").eq("org_id", orgId).eq("key", "first_day_of_week").maybeSingle(),
  ]);
  if (autoError) throw autoError;
  if (settingsError) throw settingsError;

  const firstDayOfWeek = parseInt(settings?.value ?? "6", 10);
  const autoWeeks = new Set((autoDates ?? []).map((r) => weekStartFor(dateKey(r.date), firstDayOfWeek)));
  if (autoWeeks.size === 0) return;

  let weeks = [...autoWeeks].sort();
  if (dates && dates.length > 0) {
    const affected = new Set(dates.map((d) => weekStartFor(dateKey(d), firstDayOfWeek)));
    weeks = weeks.filter((w) => affected.has(w));
  }

  for (const weekStart of weeks.slice(0, MAX_WEEKS_PER_SYNC)) {
    await syncAutoDraftsForWeek(supabase, orgId, weekStart, { onlyIfAuto: true });
  }
}
