import { describe, it, expect } from "vitest";
import { syncAutoDraftsForWeek, resyncAutoDrafts, weekStartFor } from "./auto-schedule-server";
import { makeSupabaseClient, MOCK_ORG_ID } from "../app/api/__tests__/helpers";

// 2026-01-05 is a Monday.
const WEEK_START = "2026-01-05";

// Coverage: Mondays (day_of_week 1) need 1 person 9 AM – 5 PM.
const COVERAGE_TABLES = {
  coverage_profiles:       { data: [{ id: 7 }], error: null },
  coverage_profile_blocks: { data: [{ profile_id: 7, start_minutes: 540, end_minutes: 1020, headcount: 1 }], error: null },
  coverage_day_defaults:   { data: [{ day_of_week: 1, profile_id: 7 }], error: null },
  coverage_date_overrides: { data: [], error: null },
};

const EMPTY_INPUT_TABLES = {
  employees:         { data: [{ id: 1, desired_hours: null }], error: null },
  availability:      { data: [], error: null },
  time_off_requests: { data: [], error: null },
  callouts:          { data: [], error: null },
  schedules:         { data: [], error: null },
  app_settings:      { data: { value: "1" }, error: null },
};

function draftBuilders(client: ReturnType<typeof makeSupabaseClient>) {
  return client.from.mock.calls
    .map((args: unknown[], i: number) => ({ table: args[0], builder: client.from.mock.results[i].value }))
    .filter((c: { table: unknown }) => c.table === "draft_schedules");
}

describe("weekStartFor", () => {
  it("maps a date to its week start for the org's first day of week", () => {
    expect(weekStartFor("2026-01-07", 1)).toBe("2026-01-05"); // Wed → Mon
    expect(weekStartFor("2026-01-05", 1)).toBe("2026-01-05"); // Mon → itself
    expect(weekStartFor("2026-01-07", 6)).toBe("2026-01-03"); // Wed → Sat
    expect(weekStartFor("2026-01-11", 0)).toBe("2026-01-11"); // Sun → itself (Sunday start)
  });
});

describe("syncAutoDraftsForWeek", () => {
  it("returns null with onlyIfAuto when the week has no auto drafts", async () => {
    const client = makeSupabaseClient({
      tableOverrides: {
        draft_schedules: { data: [{ id: 1, employee_id: 1, date: WEEK_START, start_minutes: 540, end_minutes: 1020, source: "manual" }], error: null },
        ...EMPTY_INPUT_TABLES,
        ...COVERAGE_TABLES,
      },
    });

    const result = await syncAutoDraftsForWeek(client as never, MOCK_ORG_ID, WEEK_START, { onlyIfAuto: true });
    expect(result).toBeNull();
    // Only the initial read — no delete or insert.
    for (const { builder } of draftBuilders(client)) {
      expect(builder.delete).not.toHaveBeenCalled();
      expect(builder.insert).not.toHaveBeenCalled();
    }
  });

  it("replaces auto drafts with a fresh generation and stamps source=auto", async () => {
    const client = makeSupabaseClient({
      tableOverrides: {
        draft_schedules: {
          data: [{ id: 42, employee_id: 1, date: "2026-01-06", start_minutes: 600, end_minutes: 900, source: "auto" }],
          error: null,
        },
        ...EMPTY_INPUT_TABLES,
        ...COVERAGE_TABLES,
      },
    });

    const result = await syncAutoDraftsForWeek(client as never, MOCK_ORG_ID, WEEK_START);
    expect(result).toEqual({
      created: 1,
      removed: 1,
      unfilled: [],
    });

    const builders = draftBuilders(client);
    const deleted = builders.find(({ builder }) => builder.delete.mock.calls.length > 0);
    expect(deleted).toBeDefined();
    expect(deleted!.builder.in).toHaveBeenCalledWith("id", [42]);

    const inserted = builders.find(({ builder }) => builder.insert.mock.calls.length > 0);
    expect(inserted).toBeDefined();
    expect(inserted!.builder.insert).toHaveBeenCalledWith([
      {
        org_id:        MOCK_ORG_ID,
        employee_id:   1,
        date:          WEEK_START, // Monday is the only day with a curve
        start_minutes: 540,
        end_minutes:   1020,
        source:        "auto",
      },
    ]);
  });

  it("schedules around manual drafts instead of replacing them", async () => {
    const client = makeSupabaseClient({
      tableOverrides: {
        // A manual draft already covers Monday for employee 1.
        draft_schedules: {
          data: [{ id: 5, employee_id: 1, date: WEEK_START, start_minutes: 540, end_minutes: 1020, source: "manual" }],
          error: null,
        },
        ...EMPTY_INPUT_TABLES,
        ...COVERAGE_TABLES,
      },
    });

    const result = await syncAutoDraftsForWeek(client as never, MOCK_ORG_ID, WEEK_START);
    // Coverage is already met by the manual draft: nothing generated, nothing removed.
    expect(result).toEqual({ created: 0, removed: 0, unfilled: [] });
    for (const { builder } of draftBuilders(client)) {
      expect(builder.delete).not.toHaveBeenCalled();
      expect(builder.insert).not.toHaveBeenCalled();
    }
  });

  it("excludes employees with approved time off and reports unfilled ranges", async () => {
    const client = makeSupabaseClient({
      tableOverrides: {
        draft_schedules: { data: [{ id: 9, employee_id: 1, date: WEEK_START, start_minutes: 540, end_minutes: 1020, source: "auto" }], error: null },
        ...EMPTY_INPUT_TABLES,
        time_off_requests: { data: [{ employee_id: 1, date: WEEK_START }], error: null },
        ...COVERAGE_TABLES,
      },
    });

    const result = await syncAutoDraftsForWeek(client as never, MOCK_ORG_ID, WEEK_START);
    expect(result).toEqual({
      created: 0,
      removed: 1,
      unfilled: [{ date: WEEK_START, startMinutes: 540, endMinutes: 1020, shortfall: 1 }],
    });
  });
});

describe("resyncAutoDrafts", () => {
  it("does nothing when no future auto drafts exist", async () => {
    const client = makeSupabaseClient({
      tableOverrides: {
        draft_schedules: { data: [], error: null },
        ...EMPTY_INPUT_TABLES,
        ...COVERAGE_TABLES,
      },
    });

    await resyncAutoDrafts(client as never, MOCK_ORG_ID);
    for (const { builder } of draftBuilders(client)) {
      expect(builder.delete).not.toHaveBeenCalled();
      expect(builder.insert).not.toHaveBeenCalled();
    }
  });

  it("regenerates the auto-managed week containing a changed date", async () => {
    const client = makeSupabaseClient({
      tableOverrides: {
        draft_schedules: {
          data: [{ id: 42, employee_id: 1, date: "2026-01-06", start_minutes: 600, end_minutes: 900, source: "auto" }],
          error: null,
        },
        ...EMPTY_INPUT_TABLES,
        ...COVERAGE_TABLES,
      },
    });

    // first_day_of_week=1 (Monday): 2026-01-07 falls in the week of 2026-01-05.
    await resyncAutoDrafts(client as never, MOCK_ORG_ID, { dates: ["2026-01-07"] });

    const inserted = draftBuilders(client).find(({ builder }) => builder.insert.mock.calls.length > 0);
    expect(inserted).toBeDefined();
    expect(inserted!.builder.insert.mock.calls[0][0][0]).toMatchObject({ source: "auto", date: WEEK_START });
  });

  it("skips weeks unrelated to the changed dates", async () => {
    const client = makeSupabaseClient({
      tableOverrides: {
        draft_schedules: {
          data: [{ id: 42, employee_id: 1, date: "2026-01-06", start_minutes: 600, end_minutes: 900, source: "auto" }],
          error: null,
        },
        ...EMPTY_INPUT_TABLES,
        ...COVERAGE_TABLES,
      },
    });

    // A change in a different week entirely.
    await resyncAutoDrafts(client as never, MOCK_ORG_ID, { dates: ["2026-03-02"] });

    for (const { builder } of draftBuilders(client)) {
      expect(builder.delete).not.toHaveBeenCalled();
      expect(builder.insert).not.toHaveBeenCalled();
    }
  });
});
