import { describe, it, expect } from "vitest";
import {
  isJobCode,
  formatJobCode,
  validatePreferredHours,
  effectiveWeeklyHours,
  FULL_TIME_WEEKLY_HOURS,
} from "./work-preference";

describe("isJobCode", () => {
  it("accepts the two job codes", () => {
    expect(isJobCode("full_time")).toBe(true);
    expect(isJobCode("part_time")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isJobCode("fulltime")).toBe(false);
    expect(isJobCode("")).toBe(false);
    expect(isJobCode(null)).toBe(false);
    expect(isJobCode(40)).toBe(false);
  });
});

describe("formatJobCode", () => {
  it("labels both codes", () => {
    expect(formatJobCode("full_time")).toBe("Full-time");
    expect(formatJobCode("part_time")).toBe("Part-time");
  });
});

describe("validatePreferredHours", () => {
  it("accepts integers within 1–40", () => {
    expect(validatePreferredHours(1)).toBeNull();
    expect(validatePreferredHours(25)).toBeNull();
    expect(validatePreferredHours(40)).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(validatePreferredHours(20.5)).toContain("integer");
    expect(validatePreferredHours("20")).toContain("integer");
    expect(validatePreferredHours(null)).toContain("integer");
  });

  it("rejects out-of-range values", () => {
    expect(validatePreferredHours(0)).toContain("between");
    expect(validatePreferredHours(41)).toContain("between");
    expect(validatePreferredHours(-5)).toContain("between");
  });
});

describe("effectiveWeeklyHours", () => {
  it("is always 40 for full-time, ignoring any stored preference", () => {
    expect(effectiveWeeklyHours("full_time", null)).toBe(FULL_TIME_WEEKLY_HOURS);
    expect(effectiveWeeklyHours("full_time", 20)).toBe(FULL_TIME_WEEKLY_HOURS);
  });

  it("is the chosen target for part-time", () => {
    expect(effectiveWeeklyHours("part_time", 24)).toBe(24);
  });

  it("is null for part-time with no preference set", () => {
    expect(effectiveWeeklyHours("part_time", null)).toBeNull();
  });
});
