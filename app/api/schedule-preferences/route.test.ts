import { describe, it, expect, vi, beforeEach } from "vitest";
import { PATCH } from "./route";
import { createClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase-admin";
import { makeSupabaseClient, MOCK_USER } from "../__tests__/helpers";

vi.mock("@/lib/supabase-server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ createAdminClient: vi.fn() }));
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
const mockCreateAdminClient = vi.mocked(createAdminClient);

function makeAdminClient(updateError: any = null) {
  const builder: any = {};
  for (const m of ["update", "insert", "eq"]) builder[m] = vi.fn().mockReturnValue(builder);
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve({ error: updateError }).then(resolve, reject);
  return { from: vi.fn().mockReturnValue(builder) };
}

function patchReq(body: unknown) {
  return new Request("http://localhost/api/schedule-preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/schedule-preferences", () => {
  beforeEach(() => {
    mockCreateAdminClient.mockReturnValue(makeAdminClient() as any);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("returns 400 when employeeId is missing", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: MOCK_USER, isManager: true }) as any);
    const res = await PATCH(patchReq({ idealHours: 25 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("employeeId") });
  });

  it("returns 400 when idealHours is missing entirely", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: MOCK_USER, isManager: true }) as any);
    const res = await PATCH(patchReq({ employeeId: 1 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("idealHours") });
  });

  it("returns 400 for negative idealHours", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: MOCK_USER, isManager: true }) as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: -5 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for idealHours above 168", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: MOCK_USER, isManager: true }) as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: 169 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-integer idealHours", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: MOCK_USER, isManager: true }) as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: 20.5 }));
    expect(res.status).toBe(400);
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockCreateClient.mockResolvedValue(makeSupabaseClient({ user: null }) as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: 25 }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when a non-manager sets ANOTHER employee's ideal hours", async () => {
    // User is linked to employee #2, request targets employee #1
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: false,
      linkedEmployee: { id: 2, user_id: MOCK_USER.id },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: 25 }));
    expect(res.status).toBe(403);
  });

  // ── Success ─────────────────────────────────────────────────────────────────

  it("returns 200 when a manager sets any employee's ideal hours (RLS client)", async () => {
    const adminClient = makeAdminClient();
    mockCreateAdminClient.mockReturnValue(adminClient as any);
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      linkedEmployee: { id: 1, name: "Alice", ideal_hours: null },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: 25 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Manager path writes through the RLS-scoped client, not the admin client
    // (the admin client is still used for the audit_logs insert)
    expect(adminClient.from).not.toHaveBeenCalledWith("employees");
  });

  it("returns 200 when an employee sets their OWN ideal hours (admin client)", async () => {
    const adminClient = makeAdminClient();
    mockCreateAdminClient.mockReturnValue(adminClient as any);
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: false,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, name: "Alice", ideal_hours: 20 },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: 30 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Self-service path must bypass the manager-only RLS via the admin client
    expect(adminClient.from).toHaveBeenCalledWith("employees");
  });

  it("accepts null to clear ideal hours", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: false,
      linkedEmployee: { id: 1, user_id: MOCK_USER.id, name: "Alice", ideal_hours: 20 },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: null }));
    expect(res.status).toBe(200);
  });

  // ── Not found / DB error ────────────────────────────────────────────────────

  it("returns 404 when the employee does not exist in the org", async () => {
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      linkedEmployee: null,
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PATCH(patchReq({ employeeId: 99, idealHours: 25 }));
    expect(res.status).toBe(404);
  });

  it("returns 500 when the update fails", async () => {
    // Lookup succeeds (queryData) but the awaited update resolves with an error
    const client = makeSupabaseClient({
      user: MOCK_USER,
      isManager: true,
      queryData: { id: 1, name: "Alice", ideal_hours: null },
      queryError: { message: "db error" },
    });
    mockCreateClient.mockResolvedValue(client as any);
    const res = await PATCH(patchReq({ employeeId: 1, idealHours: 25 }));
    expect(res.status).toBe(500);
  });
});
