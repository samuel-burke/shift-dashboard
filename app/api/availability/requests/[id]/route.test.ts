import { describe, it, expect, vi } from "vitest";
import { PUT, DELETE } from "./route";
import { createClient } from "@/lib/supabase-server";
import { makeSupabaseClient, MOCK_USER } from "../../../__tests__/helpers";

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

function putReq(status: string) {
  return new Request("http://localhost/api/availability/requests/7", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

function deleteReq() {
  return new Request("http://localhost/api/availability/requests/7", { method: "DELETE" });
}

const params = { params: Promise.resolve({ id: "7" }) };

const WINDOW_REQUEST = {
  id: 7,
  employee_id: 3,
  day_of_week: 1,
  requested_start_minutes: 720,
  requested_end_minutes: 1320,
  requested_note: null,
  requested_clear: false,
  status: "pending",
};

describe("PUT /api/availability/requests/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: null }) as any);
    const res = await PUT(putReq("approved"), params);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-managers", async () => {
    mockCreateClient.mockResolvedValue(
      makeSupabaseClient({ user: MOCK_USER, isManager: false }) as any
    );
    const res = await PUT(putReq("approved"), params);
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid status", async () => {
    mockCreateClient.mockResolvedValue(
      makeSupabaseClient({ user: MOCK_USER, isManager: true }) as any
    );
    const res = await PUT(putReq("maybe"), params);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the request does not exist", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: null, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq("approved"), params);
    expect(res.status).toBe(404);
  });

  it("returns 409 when the request was already decided", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: { ...WINDOW_REQUEST, status: "approved" }, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq("approved"), params);
    expect(res.status).toBe(409);
  });

  it("approving applies the requested window to availability", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: WINDOW_REQUEST, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq("approved"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(client.from).toHaveBeenCalledWith("availability");
  });

  it("approving a clear request removes the availability restriction", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: {
          data: { ...WINDOW_REQUEST, requested_start_minutes: null, requested_end_minutes: null, requested_clear: true },
          error: null,
        },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq("approved"), params);
    expect(res.status).toBe(200);
    expect(client.from).toHaveBeenCalledWith("availability");
  });

  it("denying never touches the availability table", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: WINDOW_REQUEST, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq("denied"), params);
    expect(res.status).toBe(200);
    expect(client.from).not.toHaveBeenCalledWith("availability");
  });

  it("returns 500 when applying the change fails", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      queryError: { message: "db error" },
      tableOverrides: {
        availability_change_requests: { data: WINDOW_REQUEST, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PUT(putReq("approved"), params);
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/availability/requests/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: null }) as any);
    const res = await DELETE(deleteReq(), params);
    expect(res.status).toBe(401);
  });

  it("lets an employee cancel their OWN pending request", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: false,
      linkedEmployee: { id: 3, user_id: MOCK_USER.id },
      tableOverrides: {
        availability_change_requests: { data: WINDOW_REQUEST, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await DELETE(deleteReq(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 403 when an employee cancels ANOTHER employee's request", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: false,
      linkedEmployee: { id: 99, user_id: MOCK_USER.id },
      tableOverrides: {
        availability_change_requests: { data: WINDOW_REQUEST, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await DELETE(deleteReq(), params);
    expect(res.status).toBe(403);
  });

  it("lets a manager cancel any pending request", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: WINDOW_REQUEST, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await DELETE(deleteReq(), params);
    expect(res.status).toBe(200);
  });

  it("returns 409 when the request was already decided", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: { ...WINDOW_REQUEST, status: "denied" }, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await DELETE(deleteReq(), params);
    expect(res.status).toBe(409);
  });

  it("returns 404 when the request does not exist", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      tableOverrides: {
        availability_change_requests: { data: null, error: null },
      },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await DELETE(deleteReq(), params);
    expect(res.status).toBe(404);
  });
});
