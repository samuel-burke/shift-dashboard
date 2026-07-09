import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, DELETE } from "./route";
import { createClient } from "@/lib/supabase-server";
import { makeSupabaseClient, MOCK_USER } from "../../__tests__/helpers";

vi.mock("@/lib/supabase-server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: any, init?: { status?: number }) =>
      new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
}));

const mockCreateClient = vi.mocked(createClient);

// 2026-01-05 is a Monday; day_of_week 1 has a curve needing 1 person 9 AM – 5 PM.
const WEEK_START = "2026-01-05";

function makeClient({
  user = MOCK_USER as any,
  isManager = true,
  drafts = [] as any[],
  draftsError = null as any,
} = {}) {
  return makeSupabaseClient({
    user,
    isManager,
    tableOverrides: {
      draft_schedules:         { data: drafts, error: draftsError },
      employees:               { data: [{ id: 1, desired_hours: null }], error: null },
      availability:            { data: [], error: null },
      time_off_requests:       { data: [], error: null },
      callouts:                { data: [], error: null },
      schedules:               { data: [], error: null },
      coverage_profiles:       { data: [{ id: 7 }], error: null },
      coverage_profile_blocks: { data: [{ profile_id: 7, start_minutes: 540, end_minutes: 1020, headcount: 1 }], error: null },
      coverage_day_defaults:   { data: [{ day_of_week: 1, profile_id: 7 }], error: null },
      coverage_date_overrides: { data: [], error: null },
    },
  });
}

function postReq(body: unknown) {
  return new Request("http://localhost/api/drafts/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/drafts/generate — validation", () => {
  beforeEach(() => {
    mockCreateClient.mockResolvedValue(makeClient() as any);
  });

  it("returns 400 when weekStart is missing", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("weekStart") });
  });

  it("returns 400 for invalid weekStart format", async () => {
    const res = await POST(postReq({ weekStart: "01-05-2026" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("YYYY-MM-DD") });
  });
});

describe("POST /api/drafts/generate — auth", () => {
  it("returns 401 when not authenticated", async () => {
    mockCreateClient.mockResolvedValue(makeClient({ user: null, isManager: false }) as any);
    const res = await POST(postReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when authenticated but not a manager", async () => {
    mockCreateClient.mockResolvedValue(makeClient({ isManager: false }) as any);
    const res = await POST(postReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/drafts/generate — generation", () => {
  it("generates shifts for the week's coverage curve", async () => {
    mockCreateClient.mockResolvedValue(makeClient() as any);
    const res = await POST(postReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, removed: 0, unfilled: [] });
  });

  it("reports replaced auto drafts", async () => {
    mockCreateClient.mockResolvedValue(makeClient({
      drafts: [{ id: 42, employee_id: 1, date: "2026-01-06", start_minutes: 600, end_minutes: 900, source: "auto" }],
    }) as any);
    const res = await POST(postReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, removed: 1, unfilled: [] });
  });

  it("returns 500 when loading drafts fails", async () => {
    mockCreateClient.mockResolvedValue(makeClient({ draftsError: { message: "db error" } }) as any);
    const res = await POST(postReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(500);
  });
});

function deleteReq(body: unknown) {
  return new Request("http://localhost/api/drafts/generate", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("DELETE /api/drafts/generate", () => {
  it("returns 400 when weekStart is missing", async () => {
    mockCreateClient.mockResolvedValue(makeClient() as any);
    const res = await DELETE(deleteReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    mockCreateClient.mockResolvedValue(makeClient({ user: null, isManager: false }) as any);
    const res = await DELETE(deleteReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a manager", async () => {
    mockCreateClient.mockResolvedValue(makeClient({ isManager: false }) as any);
    const res = await DELETE(deleteReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(403);
  });

  it("removes the week's auto drafts and reports the count", async () => {
    const client = makeClient({
      drafts: [
        { id: 42 },
        { id: 43 },
      ],
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await DELETE(deleteReq({ weekStart: WEEK_START }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 2 });
    // The delete is scoped to auto drafts only.
    const draftsBuilder = client.from.mock.results
      .filter((_: unknown, i: number) => client.from.mock.calls[i][0] === "draft_schedules")
      .map((r: { value: unknown }) => r.value)
      .find((b: any) => b.delete.mock.calls.length > 0) as any;
    expect(draftsBuilder).toBeDefined();
    expect(draftsBuilder.eq).toHaveBeenCalledWith("source", "auto");
  });
});
