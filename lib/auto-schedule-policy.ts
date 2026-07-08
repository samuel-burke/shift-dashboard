// Per-organization auto-scheduling policy.
//
// Orgs tune how the schedule generator (lib/auto-schedule.ts) behaves: the
// shortest and longest shift it may create, the minimum rest between shifts on
// consecutive days (the anti-"clopening" rule), and the weekly hours cap it
// must never schedule anyone past.
//
// Stored in app_settings as individual text key/value rows (same shape as every
// other org setting) and parsed into this typed object. Unset keys fall back to
// DEFAULT_AUTO_SCHEDULE_POLICY, so existing orgs get sane behavior with no
// migration.

import {
  DEFAULT_MAX_SHIFT_MINUTES,
  DEFAULT_MIN_REST_MINUTES,
  DEFAULT_MIN_SHIFT_MINUTES,
} from "./auto-schedule";
import { WEEKLY_OVERTIME_THRESHOLD_MINUTES } from "./schedule-hours";

export type AutoSchedulePolicy = {
  // Shortest shift the generator may create.
  minShiftMinutes: number;
  // Longest shift the generator may create.
  maxShiftMinutes: number;
  // Minimum rest between shifts on consecutive days. 0 disables the rule.
  minRestMinutes: number;
  // Hard weekly cap per employee — overtime prevention.
  maxWeekMinutes: number;
};

export const DEFAULT_AUTO_SCHEDULE_POLICY: AutoSchedulePolicy = {
  minShiftMinutes: DEFAULT_MIN_SHIFT_MINUTES,
  maxShiftMinutes: DEFAULT_MAX_SHIFT_MINUTES,
  minRestMinutes: DEFAULT_MIN_REST_MINUTES,
  maxWeekMinutes: WEEKLY_OVERTIME_THRESHOLD_MINUTES,
};

// Field ↔ app_settings key mapping, used for both parsing and validation. Kept
// as data so parse/serialize/validate can never drift out of sync. Shift
// lengths must stay on the 15-minute slot grid the generator sweeps.
const NUMERIC_FIELDS: {
  field: keyof AutoSchedulePolicy;
  key: string;
  min: number;
  max: number;
  slotAligned: boolean;
}[] = [
  { field: "minShiftMinutes", key: "auto_min_shift_minutes", min: 60, max: 960,  slotAligned: true },
  { field: "maxShiftMinutes", key: "auto_max_shift_minutes", min: 60, max: 960,  slotAligned: true },
  { field: "minRestMinutes",  key: "auto_min_rest_minutes",  min: 0,  max: 1440, slotAligned: false },
  { field: "maxWeekMinutes",  key: "auto_max_week_minutes",  min: 60, max: 4800, slotAligned: false },
];

export const AUTO_SCHEDULE_POLICY_KEYS = NUMERIC_FIELDS.map((f) => f.key);

function parseInt10(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Builds an AutoSchedulePolicy from a raw app_settings key→value map.
export function parseAutoSchedulePolicy(map: Record<string, string>): AutoSchedulePolicy {
  const policy = { ...DEFAULT_AUTO_SCHEDULE_POLICY };
  for (const { field, key } of NUMERIC_FIELDS) {
    policy[field] = parseInt10(map[key], DEFAULT_AUTO_SCHEDULE_POLICY[field]);
  }
  return policy;
}

// Validates a partial policy patch and converts it to app_settings rows.
// Returns an error string instead of rows when any provided field is malformed
// or the min/max shift pair (when both are present) is inverted.
export function autoSchedulePolicyRows(
  input: Record<string, unknown>
): { rows: { key: string; value: string }[]; error: string | null } {
  const rows: { key: string; value: string }[] = [];

  for (const { field, key, min, max, slotAligned } of NUMERIC_FIELDS) {
    const v = input[field];
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max)
      return { rows: [], error: `${field} must be an integer between ${min} and ${max}` };
    if (slotAligned && n % 15 !== 0)
      return { rows: [], error: `${field} must be a multiple of 15 minutes` };
    rows.push({ key, value: String(n) });
  }

  const minShift = input.minShiftMinutes;
  const maxShift = input.maxShiftMinutes;
  if (minShift !== undefined && maxShift !== undefined && Number(minShift) > Number(maxShift))
    return { rows: [], error: "minShiftMinutes must not exceed maxShiftMinutes" };

  return { rows, error: null };
}
