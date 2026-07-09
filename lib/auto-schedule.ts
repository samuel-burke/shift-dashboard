// Automatic schedule generation. Given the week's target coverage curves and
// each employee's constraints, produce draft shifts that fill the curves as
// closely as possible. Pure and deterministic — the same inputs always yield
// the same schedule, so a resync after an input change (coverage curve edit,
// time-off approval, call-out) is a clean regeneration, not a diff.
//
// Constraints honored, from hard to soft:
//   - approved time off / call-outs: never scheduled that day
//   - availability: shifts fit inside the employee's day-of-week window
//   - one shift per employee per day (matches draft_schedules' unique key)
//   - weekly overtime cap (default 40h): never exceeded, counting fixed
//     shifts (manual drafts + already-published schedules) toward the total
//   - minimum rest between shifts on consecutive days (default 10h): nobody
//     closes and then opens the next morning ("clopening")
//   - shift length: between min and max (defaults 4h–8h)
//   - desired weekly hours: soft target — employees under their target are
//     preferred, and an auto shift is not extended past it
//
// Times are minutes since midnight at 15-minute resolution, like the curves.

import { CoverageBlock, SLOT_MINUTES, UnderstaffedRange, findUnderstaffedFromCurves, targetAt } from "./coverage";
import { ShiftSpan, dayOfWeek } from "./draft-metrics";
import { WEEKLY_OVERTIME_THRESHOLD_MINUTES } from "./schedule-hours";

export const DEFAULT_MIN_SHIFT_MINUTES = 4 * 60;
export const DEFAULT_MAX_SHIFT_MINUTES = 8 * 60;
export const DEFAULT_MIN_REST_MINUTES = 10 * 60;

export type AutoScheduleEmployee = {
  id: number;
  /** Soft weekly target in hours. Null/undefined = no preference. */
  desiredHours?: number | null;
};

/** One row per (employee, day of week). No row = available any time that day. */
export type AvailabilityRule = {
  employeeId: number;
  dayOfWeek: number;
  startMinutes: number | null; // null start+end = unavailable all day
  endMinutes: number | null;
};

export type FixedShift = ShiftSpan & { employeeId: number };
export type GeneratedShift = { employeeId: number; date: string; startMinutes: number; endMinutes: number };

export type AutoScheduleInput = {
  /** The dates to schedule (typically one week), YYYY-MM-DD. */
  dates: string[];
  /** Target coverage curve per date (see lib/coverage.ts). */
  curves: Record<string, CoverageBlock[]>;
  employees: AutoScheduleEmployee[];
  availability: AvailabilityRule[];
  /** Dates an employee cannot work: approved time off and call-outs. */
  unavailableDates: { employeeId: number; date: string }[];
  /**
   * Shifts that already exist and must not move: manual drafts and published
   * schedules in the same week. They count toward coverage, the one-shift-per-
   * day rule, and weekly hour totals.
   */
  fixedShifts: FixedShift[];
  minShiftMinutes?: number;
  maxShiftMinutes?: number;
  /** Hard weekly cap per employee, in minutes. Default: 40h. */
  weeklyLimitMinutes?: number;
  /** Minimum rest between shifts on consecutive days. Default: 10h; 0 disables. */
  minRestMinutes?: number;
};

export type AutoScheduleResult = {
  shifts: GeneratedShift[];
  /** Curve ranges still understaffed after generation (nobody left to assign). */
  unfilled: UnderstaffedRange[];
};

type Window = { start: number; end: number } | null; // null = off all day

function availabilityWindow(
  rules: Map<string, AvailabilityRule>,
  employeeId: number,
  dow: number
): Window {
  const rule = rules.get(`${employeeId}|${dow}`);
  if (!rule) return { start: 0, end: 1440 };
  if (rule.startMinutes === null || rule.endMinutes === null) return null;
  return { start: rule.startMinutes, end: rule.endMinutes };
}

function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function generateAutoSchedule(input: AutoScheduleInput): AutoScheduleResult {
  const minShift = input.minShiftMinutes ?? DEFAULT_MIN_SHIFT_MINUTES;
  const maxShift = input.maxShiftMinutes ?? DEFAULT_MAX_SHIFT_MINUTES;
  const weeklyLimit = input.weeklyLimitMinutes ?? WEEKLY_OVERTIME_THRESHOLD_MINUTES;
  const minRest = input.minRestMinutes ?? DEFAULT_MIN_REST_MINUTES;

  const rules = new Map(input.availability.map((r) => [`${r.employeeId}|${r.dayOfWeek}`, r]));
  const blockedDates = new Set(input.unavailableDates.map((u) => `${u.employeeId}|${u.date.slice(0, 10)}`));

  // Per employee-day shift bounds, for the rest rule between consecutive days.
  // Days are generated in order, so "yesterday" sees generated shifts too,
  // while "tomorrow" can only be constrained by fixed shifts.
  const latestEnd = new Map<string, number>();
  const earliestStart = new Map<string, number>();
  const noteShift = (employeeId: number, date: string, start: number, end: number) => {
    const key = `${employeeId}|${date}`;
    latestEnd.set(key, Math.max(latestEnd.get(key) ?? 0, end));
    earliestStart.set(key, Math.min(earliestStart.get(key) ?? 1440, start));
  };

  const weekDatesSet = new Set(input.dates);
  const assignedMinutes = new Map<number, number>(input.employees.map((e) => [e.id, 0]));
  for (const f of input.fixedShifts) {
    noteShift(f.employeeId, f.date.slice(0, 10), f.startMinutes, f.endMinutes);
    if (!weekDatesSet.has(f.date.slice(0, 10))) continue;
    if (!assignedMinutes.has(f.employeeId)) continue;
    assignedMinutes.set(f.employeeId, assignedMinutes.get(f.employeeId)! + (f.endMinutes - f.startMinutes));
  }

  const desiredMinutes = new Map<number, number | null>(
    input.employees.map((e) => [e.id, e.desiredHours == null ? null : e.desiredHours * 60])
  );

  const generated: GeneratedShift[] = [];

  for (const date of input.dates) {
    const blocks = input.curves[date] ?? [];
    if (blocks.length === 0 || blocks.every((b) => b.headcount <= 0)) continue;

    const dow = dayOfWeek(date);
    const dayStart = Math.min(...blocks.map((b) => b.startMinutes));
    const dayEnd = Math.max(...blocks.map((b) => b.endMinutes));

    // Scheduled headcount per 15-min slot, seeded from fixed shifts.
    const slotCount = Math.ceil(1440 / SLOT_MINUTES);
    const supply = new Array<number>(slotCount).fill(0);
    const addSupply = (start: number, end: number) => {
      for (let t = start; t < end; t += SLOT_MINUTES) supply[Math.floor(t / SLOT_MINUTES)]++;
    };
    const workingToday = new Set<number>();
    for (const f of input.fixedShifts) {
      if (f.date.slice(0, 10) !== date) continue;
      addSupply(f.startMinutes, f.endMinutes);
      workingToday.add(f.employeeId);
    }

    const deficitAt = (t: number) => targetAt(blocks, t) - supply[Math.floor(t / SLOT_MINUTES)];

    for (let t = dayStart; t < dayEnd; t += SLOT_MINUTES) {
      while (deficitAt(t) > 0) {
        const candidate = pickCandidate(t);
        if (!candidate) break; // nobody can start here — leave the gap and move on
        const end = shiftEnd(candidate, t);
        generated.push({ employeeId: candidate.id, date, startMinutes: t, endMinutes: end });
        addSupply(t, end);
        workingToday.add(candidate.id);
        noteShift(candidate.id, date, t, end);
        assignedMinutes.set(candidate.id, assignedMinutes.get(candidate.id)! + (end - t));
      }
    }

    /**
     * Best employee able to start a shift of at least minShift at `t`, or null.
     * Preference order: under desired hours first, then lowest share of their
     * target already assigned, then fewest minutes, then id (determinism).
     */
    function pickCandidate(t: number): AutoScheduleEmployee | null {
      let best: AutoScheduleEmployee | null = null;
      let bestKey: [number, number, number, number] | null = null;
      for (const emp of input.employees) {
        if (workingToday.has(emp.id)) continue;
        if (blockedDates.has(`${emp.id}|${date}`)) continue;
        const win = availabilityWindow(rules, emp.id, dow);
        if (!win || t < win.start || t + minShift > win.end) continue;
        const assigned = assignedMinutes.get(emp.id)!;
        if (assigned + minShift > weeklyLimit) continue;
        // Rest rule: enough downtime since yesterday's shift, and even the
        // minimum shift must leave enough before tomorrow's fixed start.
        const prevEnd = latestEnd.get(`${emp.id}|${addDays(date, -1)}`);
        if (prevEnd !== undefined && 1440 - prevEnd + t < minRest) continue;
        const nextStart = earliestStart.get(`${emp.id}|${addDays(date, 1)}`);
        if (nextStart !== undefined && 1440 - (t + minShift) + nextStart < minRest) continue;
        const desired = desiredMinutes.get(emp.id) ?? null;
        const overDesired = desired !== null && assigned >= desired ? 1 : 0;
        const fillRatio = assigned / Math.max(desired ?? weeklyLimit, 1);
        const key: [number, number, number, number] = [overDesired, fillRatio, assigned, emp.id];
        if (
          bestKey === null ||
          key[0] < bestKey[0] ||
          (key[0] === bestKey[0] && (key[1] < bestKey[1] ||
            (key[1] === bestKey[1] && (key[2] < bestKey[2] ||
              (key[2] === bestKey[2] && key[3] < bestKey[3])))))
        ) {
          best = emp;
          bestKey = key;
        }
      }
      return best;
    }

    /** Extend the shift past the minimum while it still covers a deficit. */
    function shiftEnd(emp: AutoScheduleEmployee, start: number): number {
      const win = availabilityWindow(rules, emp.id, dow)!;
      const assigned = assignedMinutes.get(emp.id)!;
      const desired = desiredMinutes.get(emp.id) ?? null;
      let hardCap = Math.min(start + maxShift, win.end, weeklyLimit - assigned + start, 1440);
      // Don't extend into tomorrow's rest window (pickCandidate already
      // guarantees the minimum shift fits).
      const nextStart = earliestStart.get(`${emp.id}|${addDays(date, 1)}`);
      if (nextStart !== undefined) hardCap = Math.min(hardCap, 1440 + nextStart - minRest);
      // Soft-stop at the desired weekly target, but never below the minimum.
      if (desired !== null) hardCap = Math.min(hardCap, Math.max(start + minShift, desired - assigned + start));
      let end = start + minShift;
      while (end < hardCap && end < dayEnd && deficitAt(end) > 0) end += SLOT_MINUTES;
      return end;
    }
  }

  const allShifts: ShiftSpan[] = [
    ...input.fixedShifts.map((f) => ({ date: f.date.slice(0, 10), startMinutes: f.startMinutes, endMinutes: f.endMinutes })),
    ...generated,
  ];
  const unfilled = findUnderstaffedFromCurves(allShifts, input.dates, input.curves);

  return { shifts: generated, unfilled };
}
