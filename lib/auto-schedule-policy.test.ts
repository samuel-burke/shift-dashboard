import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUTO_SCHEDULE_POLICY,
  AUTO_SCHEDULE_POLICY_KEYS,
  parseAutoSchedulePolicy,
  autoSchedulePolicyRows,
} from "./auto-schedule-policy";

describe("parseAutoSchedulePolicy", () => {
  it("returns defaults for an empty map", () => {
    expect(parseAutoSchedulePolicy({})).toEqual(DEFAULT_AUTO_SCHEDULE_POLICY);
  });

  it("reads stored values and falls back per-field", () => {
    const policy = parseAutoSchedulePolicy({
      auto_min_shift_minutes: "180",
      auto_min_rest_minutes: "480",
    });
    expect(policy).toEqual({
      ...DEFAULT_AUTO_SCHEDULE_POLICY,
      minShiftMinutes: 180,
      minRestMinutes: 480,
    });
  });

  it("ignores unparsable values", () => {
    expect(parseAutoSchedulePolicy({ auto_max_week_minutes: "banana" }).maxWeekMinutes)
      .toBe(DEFAULT_AUTO_SCHEDULE_POLICY.maxWeekMinutes);
  });
});

describe("autoSchedulePolicyRows", () => {
  it("converts a full patch to app_settings rows", () => {
    const { rows, error } = autoSchedulePolicyRows({
      minShiftMinutes: 180,
      maxShiftMinutes: 600,
      minRestMinutes: 720,
      maxWeekMinutes: 2100,
    });
    expect(error).toBeNull();
    expect(rows).toEqual([
      { key: "auto_min_shift_minutes", value: "180" },
      { key: "auto_max_shift_minutes", value: "600" },
      { key: "auto_min_rest_minutes",  value: "720" },
      { key: "auto_max_week_minutes",  value: "2100" },
    ]);
    expect(rows.map((r) => r.key)).toEqual(AUTO_SCHEDULE_POLICY_KEYS);
  });

  it("skips omitted fields", () => {
    const { rows, error } = autoSchedulePolicyRows({ minRestMinutes: 0 });
    expect(error).toBeNull();
    expect(rows).toEqual([{ key: "auto_min_rest_minutes", value: "0" }]);
  });

  it("rejects out-of-range values", () => {
    expect(autoSchedulePolicyRows({ minShiftMinutes: 30 }).error).toContain("minShiftMinutes");
    expect(autoSchedulePolicyRows({ maxWeekMinutes: 9000 }).error).toContain("maxWeekMinutes");
  });

  it("rejects non-integers", () => {
    expect(autoSchedulePolicyRows({ minRestMinutes: "soon" }).error).toContain("minRestMinutes");
  });

  it("rejects shift lengths off the 15-minute grid", () => {
    expect(autoSchedulePolicyRows({ minShiftMinutes: 250 }).error).toContain("multiple of 15");
  });

  it("rejects an inverted min/max shift pair", () => {
    expect(autoSchedulePolicyRows({ minShiftMinutes: 600, maxShiftMinutes: 300 }).error)
      .toContain("must not exceed");
  });
});
