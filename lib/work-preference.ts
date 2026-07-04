// Job codes and weekly-hours preferences.
//
// Every employee carries a job_code: full_time associates always work
// FULL_TIME_WEEKLY_HOURS per week (there is nothing to choose, so the app
// never stores a preference for them), while part_time associates pick their
// own weekly target, stored in the work_preferences table.

export const JOB_CODES = ["full_time", "part_time"] as const;
export type JobCode = (typeof JOB_CODES)[number];

export const FULL_TIME_WEEKLY_HOURS = 40;

// Bounds for a part-time associate's preferred weekly hours. Must match the
// work_preferences check constraint in the 0030 migration.
export const MIN_PREFERRED_HOURS = 1;
export const MAX_PREFERRED_HOURS = 40;

export function isJobCode(value: unknown): value is JobCode {
  return typeof value === "string" && (JOB_CODES as readonly string[]).includes(value);
}

export function formatJobCode(jobCode: JobCode): string {
  return jobCode === "full_time" ? "Full-time" : "Part-time";
}

/** Returns an error message, or null when the value is a valid weekly target. */
export function validatePreferredHours(value: unknown): string | null {
  if (!Number.isInteger(value))
    return "preferredHours must be an integer";
  const hours = value as number;
  if (hours < MIN_PREFERRED_HOURS || hours > MAX_PREFERRED_HOURS)
    return `preferredHours must be between ${MIN_PREFERRED_HOURS} and ${MAX_PREFERRED_HOURS}`;
  return null;
}

/**
 * The weekly hours an employee is expected to want: full-time is always
 * FULL_TIME_WEEKLY_HOURS regardless of any stored preference; part-time is
 * the associate's chosen target, or null when they haven't picked one yet.
 */
export function effectiveWeeklyHours(
  jobCode: JobCode,
  preferredHours: number | null
): number | null {
  if (jobCode === "full_time") return FULL_TIME_WEEKLY_HOURS;
  return preferredHours;
}
