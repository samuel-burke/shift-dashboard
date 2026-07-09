import { describe, it, expect } from "vitest";
import {
  generateAutoSchedule,
  DEFAULT_MIN_SHIFT_MINUTES,
  DEFAULT_MAX_SHIFT_MINUTES,
  type AutoScheduleInput,
} from "./auto-schedule";
import { WEEKLY_OVERTIME_THRESHOLD_MINUTES } from "./schedule-hours";
import { headcountAt } from "./draft-metrics";
import type { CoverageBlock } from "./coverage";

// 2026-01-05 is a Monday; the week runs Mon–Sun.
const WEEK = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10", "2026-01-11"];
const MON = WEEK[0];

/** 9 AM – 5 PM, `headcount` people. */
function block(headcount: number, start = 540, end = 1020): CoverageBlock {
  return { startMinutes: start, endMinutes: end, headcount };
}

function baseInput(overrides: Partial<AutoScheduleInput> = {}): AutoScheduleInput {
  return {
    dates: WEEK,
    curves: {},
    employees: [{ id: 1 }, { id: 2 }, { id: 3 }],
    availability: [],
    unavailableDates: [],
    fixedShifts: [],
    ...overrides,
  };
}

function totalMinutes(shifts: { employeeId: number; startMinutes: number; endMinutes: number }[], employeeId: number) {
  return shifts.filter((s) => s.employeeId === employeeId).reduce((sum, s) => sum + s.endMinutes - s.startMinutes, 0);
}

describe("generateAutoSchedule", () => {
  it("returns no shifts when there are no curves", () => {
    const result = generateAutoSchedule(baseInput());
    expect(result.shifts).toEqual([]);
    expect(result.unfilled).toEqual([]);
  });

  it("fills a single-person curve with one shift", () => {
    const result = generateAutoSchedule(baseInput({ curves: { [MON]: [block(1)] } }));
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0]).toMatchObject({ date: MON, startMinutes: 540, endMinutes: 1020 });
    expect(result.unfilled).toEqual([]);
  });

  it("covers every slot of a two-person curve", () => {
    const result = generateAutoSchedule(baseInput({ curves: { [MON]: [block(2)] } }));
    for (let t = 540; t < 1020; t += 15) {
      expect(headcountAt(result.shifts, MON, t)).toBeGreaterThanOrEqual(2);
    }
    expect(result.unfilled).toEqual([]);
  });

  it("never assigns two shifts to the same employee on one day", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(3, 480, 1260)] }, // 13h at 3 heads: forces multiple staggered shifts
      employees: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
    }));
    const seen = new Set<string>();
    for (const s of result.shifts) {
      const key = `${s.employeeId}|${s.date}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("respects shift length bounds", () => {
    const result = generateAutoSchedule(baseInput({
      curves: Object.fromEntries(WEEK.map((d) => [d, [block(2, 480, 1260)]])),
      employees: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
    }));
    for (const s of result.shifts) {
      const len = s.endMinutes - s.startMinutes;
      expect(len).toBeGreaterThanOrEqual(DEFAULT_MIN_SHIFT_MINUTES);
      expect(len).toBeLessThanOrEqual(DEFAULT_MAX_SHIFT_MINUTES);
    }
  });

  it("skips employees with approved time off that day and reports the gap when nobody is left", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(1)] },
      employees: [{ id: 1 }],
      unavailableDates: [{ employeeId: 1, date: MON }],
    }));
    expect(result.shifts).toEqual([]);
    expect(result.unfilled).toEqual([
      { date: MON, startMinutes: 540, endMinutes: 1020, shortfall: 1 },
    ]);
  });

  it("keeps shifts inside availability windows", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(1)] },
      employees: [{ id: 1 }],
      // Monday = dayOfWeek 1; only available noon–5 PM
      availability: [{ employeeId: 1, dayOfWeek: 1, startMinutes: 720, endMinutes: 1020 }],
    }));
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].startMinutes).toBeGreaterThanOrEqual(720);
    expect(result.shifts[0].endMinutes).toBeLessThanOrEqual(1020);
    // The uncovered morning is reported
    expect(result.unfilled).toEqual([
      { date: MON, startMinutes: 540, endMinutes: 720, shortfall: 1 },
    ]);
  });

  it("treats a null availability window as off all day", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(1)] },
      employees: [{ id: 1 }],
      availability: [{ employeeId: 1, dayOfWeek: 1, startMinutes: null, endMinutes: null }],
    }));
    expect(result.shifts).toEqual([]);
    expect(result.unfilled).toHaveLength(1);
  });

  it("never schedules anyone past the weekly overtime cap", () => {
    // 7 days × 12h curve with only 2 employees: demand far exceeds 40h/person
    const result = generateAutoSchedule(baseInput({
      curves: Object.fromEntries(WEEK.map((d) => [d, [block(2, 480, 1200)]])),
      employees: [{ id: 1 }, { id: 2 }],
    }));
    expect(totalMinutes(result.shifts, 1)).toBeLessThanOrEqual(WEEKLY_OVERTIME_THRESHOLD_MINUTES);
    expect(totalMinutes(result.shifts, 2)).toBeLessThanOrEqual(WEEKLY_OVERTIME_THRESHOLD_MINUTES);
    expect(result.unfilled.length).toBeGreaterThan(0);
  });

  it("counts fixed shifts toward the weekly cap", () => {
    // Employee 1 already has 36h fixed; only 4h of headroom left.
    const fixedShifts = WEEK.slice(0, 6).map((date) => ({
      employeeId: 1, date, startMinutes: 600, endMinutes: 960, // 6h × 6 days
    }));
    const result = generateAutoSchedule(baseInput({
      curves: { [WEEK[6]]: [block(1, 540, 1020)] },
      employees: [{ id: 1 }],
      fixedShifts,
    }));
    expect(totalMinutes(result.shifts, 1)).toBeLessThanOrEqual(4 * 60);
  });

  it("does not double-book a day that already has a fixed shift", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(2)] },
      employees: [{ id: 1 }, { id: 2 }],
      fixedShifts: [{ employeeId: 1, date: MON, startMinutes: 540, endMinutes: 1020 }],
    }));
    // Only employee 2 needs to be added — the fixed shift covers one head.
    expect(result.shifts.every((s) => s.employeeId === 2)).toBe(true);
    expect(result.unfilled).toEqual([]);
  });

  it("prefers employees furthest below their desired hours", () => {
    // One 8h shift each day; emp 1 wants 40h, emp 2 wants 8h.
    const result = generateAutoSchedule(baseInput({
      curves: Object.fromEntries(WEEK.slice(0, 5).map((d) => [d, [block(1, 540, 1020)]])),
      employees: [
        { id: 1, desiredHours: 40 },
        { id: 2, desiredHours: 8 },
      ],
    }));
    // Emp 2 should get roughly one day, emp 1 the rest.
    expect(totalMinutes(result.shifts, 2)).toBeLessThanOrEqual(8 * 60);
    expect(totalMinutes(result.shifts, 1)).toBeGreaterThan(totalMinutes(result.shifts, 2));
  });

  it("does not extend an auto shift past the desired weekly target", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(1, 540, 1020)] }, // 8h of demand
      employees: [
        { id: 1, desiredHours: 6 },
        { id: 2 },
      ],
    }));
    // Emp 1 stops at 6h; emp 2 cannot start mid-gap shorter than the minimum
    // if fewer than 4h remain, but here 2h remain, so the tail may go unfilled
    // or be covered by emp 2 starting earlier. Either way emp 1 stays at 6h.
    expect(totalMinutes(result.shifts, 1)).toBeLessThanOrEqual(6 * 60);
  });

  it("schedules over desired hours rather than leave a gap", () => {
    // Only one employee, desired 4h, but 8h of single-head demand: the soft
    // target caps the first shift at 4h, and no second shift may start that
    // day — the gap is reported instead of violating one-shift-per-day.
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(1)], [WEEK[1]]: [block(1)] },
      employees: [{ id: 1, desiredHours: 4 }],
    }));
    // Both days get a shift even though day 2 exceeds the desired target.
    expect(result.shifts.filter((s) => s.date === MON)).toHaveLength(1);
    expect(result.shifts.filter((s) => s.date === WEEK[1])).toHaveLength(1);
  });

  it("does not schedule an opener after a close without enough rest", () => {
    // Emp 1 closes Monday 2 PM – 10 PM (fixed). Tuesday's curve opens at 6 AM.
    // With the default 10h rest, emp 1 could start Tuesday no earlier than 8 AM,
    // so the 6 AM opener must go to emp 2.
    const result = generateAutoSchedule(baseInput({
      curves: { [WEEK[1]]: [block(1, 360, 840)] }, // Tue 6 AM – 2 PM
      employees: [{ id: 1 }, { id: 2 }],
      fixedShifts: [{ employeeId: 1, date: MON, startMinutes: 840, endMinutes: 1320 }],
    }));
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].employeeId).toBe(2);
  });

  it("delays the next-day start until the rest window has passed", () => {
    // Only emp 1 exists and they close Monday at 10 PM. Tuesday coverage from
    // 6 AM: the earliest allowed start is 8 AM (10h after 10 PM).
    const result = generateAutoSchedule(baseInput({
      curves: { [WEEK[1]]: [block(1, 360, 840)] },
      employees: [{ id: 1 }],
      fixedShifts: [{ employeeId: 1, date: MON, startMinutes: 840, endMinutes: 1320 }],
    }));
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].startMinutes).toBe(480); // 8 AM
    expect(result.unfilled).toEqual([
      { date: WEEK[1], startMinutes: 360, endMinutes: 480, shortfall: 1 },
    ]);
  });

  it("stops extending a shift that would collide with tomorrow's early fixed start", () => {
    // Emp 1 has a fixed 6 AM start on Tuesday. Monday's curve runs late; their
    // Monday shift must end by 8 PM (10h before 6 AM).
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(1, 720, 1380)] }, // Mon noon – 11 PM
      employees: [{ id: 1 }],
      fixedShifts: [{ employeeId: 1, date: WEEK[1], startMinutes: 360, endMinutes: 840 }],
    }));
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].endMinutes).toBeLessThanOrEqual(1200); // 8 PM
  });

  it("allows clopening when minRestMinutes is 0", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [WEEK[1]]: [block(1, 360, 840)] },
      employees: [{ id: 1 }],
      fixedShifts: [{ employeeId: 1, date: MON, startMinutes: 840, endMinutes: 1320 }],
      minRestMinutes: 0,
    }));
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].startMinutes).toBe(360); // 6 AM sharp
  });

  it("applies the rest rule between two generated shifts on consecutive days", () => {
    // Single employee; Monday's curve ends at midnight, Tuesday's starts at
    // 6 AM. Monday's generated closer must push Tuesday's start past the rest.
    const result = generateAutoSchedule(baseInput({
      curves: {
        [MON]: [block(1, 960, 1440)],     // Mon 4 PM – midnight
        [WEEK[1]]: [block(1, 360, 840)],  // Tue 6 AM – 2 PM
      },
      employees: [{ id: 1 }],
    }));
    const mon = result.shifts.find((s) => s.date === MON)!;
    const tue = result.shifts.find((s) => s.date === WEEK[1])!;
    expect(1440 - mon.endMinutes + tue.startMinutes).toBeGreaterThanOrEqual(600);
  });

  it("is deterministic", () => {
    const input = baseInput({
      curves: Object.fromEntries(WEEK.map((d) => [d, [block(2, 480, 1200)]])),
      employees: [{ id: 3 }, { id: 1, desiredHours: 20 }, { id: 2 }],
    });
    expect(generateAutoSchedule(input)).toEqual(generateAutoSchedule(input));
  });

  it("aligns generated shifts to 15-minute slots", () => {
    const result = generateAutoSchedule(baseInput({
      curves: { [MON]: [block(2, 495, 1005)] },
    }));
    for (const s of result.shifts) {
      expect(s.startMinutes % 15).toBe(0);
      expect(s.endMinutes % 15).toBe(0);
    }
  });
});
