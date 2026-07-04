import { describe, it, expect, vi } from "vitest";
import { GET, PUT } from "./route";
import { createClient } from "@/lib/supabase-server";
import { makeSupabaseClient, MOCK_USER, MOCK_ORG_ID } from "../__tests__/helpers";

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

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/work-preferences", () => {
  it("returns jobCode, preferredHours, and effectiveHours for a part-time employee", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, job_code: "part_time" },
      tableOverrides: { work_preferences: { data: { preferred_hours: 24 }, error: null } },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/work-preferences?employeeId=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      employeeId: 1,
      jobCode: "part_time",
      preferredHours: 24,
      effectiveHours: 24,
    });
  });

  it("returns null hours for a part-time employee with no stored preference", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, job_code: "part_time" },
      tableOverrides: { work_preferences: { data: null, error: null } },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/work-preferences?employeeId=1"));
    expect(await res.json()).toMatchObject({ preferredHours: null, effectiveHours: null });
  });

  it("always reports 40 effective hours for a full-time employee", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, job_code: "full_time" },
      // Even a leftover stored preference must not change the answer.
      tableOverrides: { work_preferences: { data: { preferred_hours: 16 }, error: null } },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/work-preferences?employeeId=1"));
    expect(await res.json()).toMatchObject({ jobCode: "full_time", effectiveHours: 40 });
  });

  it("returns 400 when employeeId is missing or invalid", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: MOCK_USER }) as any);
    expect((await GET(new Request("http://localhost/api/work-preferences"))).status).toBe(400);
    expect(
      (await GET(new Request("http://localhost/api/work-preferences?employeeId=abc"))).status
    ).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: null }) as any);
    const res = await GET(new Request("http://localhost/api/work-preferences?employeeId=1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the employee does not exist in the org", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      linkedEmployee: null,
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/work-preferences?employeeId=99"));
    expect(res.status).toBe(404);
  });
});

// ── PUT ──────────────────────────────────────────────────────────────────────

function putReq(body: unknown) {
  return new Request("http://localhost/api/work-preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/work-preferences", () => {
  it("lets an employee set their own preferred hours", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, name: "Jane Smith", job_code: "part_time" },
      tableOverrides: { work_preferences: { data: null, error: null } },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq({ employeeId: 1, preferredHours: 24 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("stamps org_id on the upserted row", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, name: "Jane Smith", job_code: "part_time" },
      tableOverrides: { work_preferences: { data: null, error: null } },
    });
    mockCreateClient.mockResolvedValue(client as any);
    await PUT(putReq({ employeeId: 1, preferredHours: 24 }));

    const upsertCall = (client.from as any).mock.results
      .map((r: any) => r.value)
      .find((b: any) => b?.upsert?.mock?.calls?.length > 0);
    expect(upsertCall.upsert.mock.calls[0][0]).toMatchObject({
      org_id: MOCK_ORG_ID,
      employee_id: 1,
      preferred_hours: 24,
    });
    expect(upsertCall.upsert.mock.calls[0][1]).toEqual({ onConflict: "org_id,employee_id" });
  });

  it("forbids an employee from setting someone else's preference", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, job_code: "part_time" },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq({ employeeId: 2, preferredHours: 24 }));
    expect(res.status).toBe(403);
  });

  it("lets a manager set any employee's preference", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      linkedEmployee: { id: 5, name: "Bob Lee", job_code: "part_time" },
      tableOverrides: { work_preferences: { data: null, error: null } },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq({ employeeId: 5, preferredHours: 32 }));
    expect(res.status).toBe(200);
  });

  it("rejects setting a preference for a full-time employee", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, name: "Jane Smith", job_code: "full_time" },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq({ employeeId: 1, preferredHours: 24 }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("40 hours"),
    });
  });

  it("validates preferredHours bounds and type", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, job_code: "part_time" },
    });
    mockCreateClient.mockResolvedValue(client as any);
    expect((await PUT(putReq({ employeeId: 1, preferredHours: 0 }))).status).toBe(422);
    expect((await PUT(putReq({ employeeId: 1, preferredHours: 41 }))).status).toBe(422);
    expect((await PUT(putReq({ employeeId: 1, preferredHours: 20.5 }))).status).toBe(422);
    expect((await PUT(putReq({ employeeId: 1 }))).status).toBe(422);
  });

  it("returns 400 when employeeId is missing", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: MOCK_USER }) as any);
    const res = await PUT(putReq({ preferredHours: 24 }));
    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: null }) as any);
    const res = await PUT(putReq({ employeeId: 1, preferredHours: 24 }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the employee does not exist", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      linkedEmployee: null,
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq({ employeeId: 99, preferredHours: 24 }));
    expect(res.status).toBe(404);
  });

  it("returns 500 when the upsert fails", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, name: "Jane Smith", job_code: "part_time" },
      tableOverrides: { work_preferences: { data: null, error: { message: "db down" } } },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq({ employeeId: 1, preferredHours: 24 }));
    expect(res.status).toBe(500);
  });
});
