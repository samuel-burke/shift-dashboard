import { describe, it, expect, vi } from "vitest";
import { GET } from "./route";
import { createClient } from "@/lib/supabase-server";
import { makeSupabaseClient, MOCK_USER } from "../../__tests__/helpers";

vi.mock("@/lib/supabase-server", () => ({ createClient: vi.fn() }));
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

const PENDING_ROWS = [
  {
    id: 7,
    employee_id: 3,
    day_of_week: 1,
    requested_start_minutes: 720,
    requested_end_minutes: 1320,
    requested_note: null,
    requested_clear: false,
    status: "pending",
    created_at: "2026-07-14T00:00:00Z",
  },
];

describe("GET /api/availability/requests", () => {
  it("returns 401 when unauthenticated", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: null }) as any);
    const res = await GET(new Request("http://localhost/api/availability/requests"));
    expect(res.status).toBe(401);
  });

  it("returns the org's pending requests with employee names for managers", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: PENDING_ROWS, error: null },
        employees: { data: [{ id: 3, name: "Carol White" }], error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/availability/requests"));
    expect(res.status).toBe(200);
    const { requests } = await res.json();
    expect(requests).toEqual([
      {
        id: 7,
        employeeId: 3,
        employeeName: "Carol White",
        dayOfWeek: 1,
        startMinutes: 720,
        endMinutes: 1320,
        note: null,
        clear: false,
        status: "pending",
        createdAt: "2026-07-14T00:00:00Z",
      },
    ]);
  });

  it("returns 400 for a non-integer employeeId filter", async () => {
    const client = makeSupabaseClient({ user: MOCK_USER, isManager: true });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/availability/requests?employeeId=abc"));
    expect(res.status).toBe(400);
  });

  it("returns own requests for a linked employee", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: false,
      linkedEmployee: { id: 3, user_id: MOCK_USER.id, name: "Carol White" },
      tableOverrides: {
        availability_change_requests: { data: PENDING_ROWS, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/availability/requests"));
    expect(res.status).toBe(200);
    const { requests } = await res.json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: 7, employeeId: 3, dayOfWeek: 1 });
  });

  it("returns 403 for a user with no org membership", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: false,
      linkedEmployee: null,
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/availability/requests"));
    expect(res.status).toBe(403);
  });

  it("returns 500 on database error", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: null, error: { message: "db error" } },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await GET(new Request("http://localhost/api/availability/requests"));
    expect(res.status).toBe(500);
  });
});
