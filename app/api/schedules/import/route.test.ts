import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { createClient } from "@/lib/supabase-server";
import { MOCK_USER, MOCK_ORG_ID } from "../../__tests__/helpers";

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

// ── Mock factory ─────────────────────────────────────────────────────────────

function makeImportClient({
  user = MOCK_USER as any,
  isManager = true,
  employees = [] as Array<{ id: number; name: string }>,
  existingSchedules = [] as Array<{ employee_id: number; date: string }>,
  employeesError = null as { message: string } | null,
  existingError = null as { message: string } | null,
  insertError = null as { message: string } | null,
} = {}) {
  const managerRow =
    isManager && user ? { user_id: user.id, org_id: MOCK_ORG_ID } : null;

  const insertSpy = vi.fn().mockResolvedValue({ data: null, error: insertError });

  function makeFullBuilder(result: { data: any; error: any }) {
    const b: any = {};
    for (const m of ["select", "eq", "limit", "order", "gte", "lte", "like", "in", "or"]) {
      b[m] = vi.fn().mockReturnValue(b);
    }
    b.maybeSingle = vi.fn().mockResolvedValue(result);
    b.single = vi.fn().mockResolvedValue(result);
    b.range = vi.fn().mockReturnValue(b);
    b.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
    return b;
  }

  // getOrgContext resolves the caller's employee row before the route's own
  // employees query runs, so route both calls through call order.
  let employeeCallCount = 0;

  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "managers") {
        return makeFullBuilder({ data: managerRow, error: null });
      }
      if (table === "employees") {
        const callIndex = employeeCallCount++;
        // First call: getOrgContext linked-employee lookup (maybeSingle).
        if (callIndex === 0) return makeFullBuilder({ data: null, error: null });
        // Later calls: the route's org roster fetch (list).
        return makeFullBuilder({ data: employeesError ? null : employees, error: employeesError });
      }
      if (table === "schedules") {
        const b = makeFullBuilder({
          data: existingError ? null : existingSchedules,
          error: existingError,
        });
        b.insert = insertSpy;
        return b;
      }
      return makeFullBuilder({ data: null, error: null });
    }),
    insertSpy,
  };
  return client;
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/schedules/import", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

const CSV = [
  "Employee Name,Date,Start Time,End Time",
  '"Smith, Jane",07/06/2026,9:00 AM,5:00 PM',
  "Bob Lee,07/07/2026,1:00 PM,9:00 PM",
].join("\n");

const ROSTER = [
  { id: 1, name: "Jane Smith" },
  { id: 2, name: "Bob Lee" },
];

describe("POST /api/schedules/import", () => {
  beforeEach(() => {
    mockCreateClient.mockResolvedValue(makeImportClient({ employees: ROSTER }) as any);
  });

  it("returns 400 when csv is missing", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("csv") });
  });

  it("returns 400 when csv is not a string", async () => {
    const res = await post({ csv: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 413 when csv exceeds the size limit", async () => {
    const res = await post({ csv: "x".repeat(1_000_001) });
    expect(res.status).toBe(413);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockCreateClient.mockResolvedValue(
      makeImportClient({ user: null, isManager: false }) as any
    );
    const res = await post({ csv: CSV });
    expect(res.status).toBe(401);
  });

  it("returns 403 for authenticated non-manager", async () => {
    mockCreateClient.mockResolvedValue(
      makeImportClient({ user: MOCK_USER, isManager: false }) as any
    );
    const res = await post({ csv: CSV });
    expect(res.status).toBe(403);
  });

  it("returns 422 with parse errors when the file has no importable shifts", async () => {
    const res = await post({ csv: "Employee,Date\nBob,07/06/2026" });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain("No importable shifts");
    expect(json.errors).toHaveLength(1);
  });

  it("imports matched shifts and stamps org_id on every row", async () => {
    const client = makeImportClient({ employees: ROSTER });
    mockCreateClient.mockResolvedValue(client as any);

    const res = await post({ csv: CSV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 2, skipped: 0, unmatched: [], errors: [] });

    const inserted = client.insertSpy.mock.calls[0][0];
    expect(inserted).toEqual([
      {
        org_id: MOCK_ORG_ID,
        employee_id: 1,
        date: "2026-07-06",
        start_minutes: 540,
        end_minutes: 1020,
      },
      {
        org_id: MOCK_ORG_ID,
        employee_id: 2,
        date: "2026-07-07",
        start_minutes: 780,
        end_minutes: 1260,
      },
    ]);
  });

  it("matches 'Last, First' CSV names against 'First Last' roster names case-insensitively", async () => {
    const client = makeImportClient({ employees: [{ id: 7, name: "jane SMITH" }] });
    mockCreateClient.mockResolvedValue(client as any);

    const csv = 'Employee Name,Date,Start Time,End Time\n"SMITH, JANE",07/06/2026,9:00 AM,5:00 PM';
    const res = await post({ csv });
    expect(await res.json()).toMatchObject({ imported: 1, unmatched: [] });
    expect(client.insertSpy.mock.calls[0][0][0]).toMatchObject({ employee_id: 7 });
  });

  it("reports unmatched employee names without failing the import", async () => {
    const client = makeImportClient({ employees: [{ id: 2, name: "Bob Lee" }] });
    mockCreateClient.mockResolvedValue(client as any);

    const res = await post({ csv: CSV });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imported: 1,
      skipped: 0,
      unmatched: ["Jane Smith"],
      errors: [],
    });
  });

  it("skips employees already scheduled on a date", async () => {
    const client = makeImportClient({
      employees: ROSTER,
      existingSchedules: [{ employee_id: 1, date: "2026-07-06" }],
    });
    mockCreateClient.mockResolvedValue(client as any);

    const res = await post({ csv: CSV });
    expect(await res.json()).toEqual({ imported: 1, skipped: 1, unmatched: [], errors: [] });
    expect(client.insertSpy.mock.calls[0][0]).toHaveLength(1);
  });

  it("skips duplicate (employee, date) rows within the file", async () => {
    const csv = [
      "Employee Name,Date,Start Time,End Time",
      "Bob Lee,07/06/2026,9:00 AM,5:00 PM",
      "Bob Lee,07/06/2026,1:00 PM,9:00 PM",
    ].join("\n");
    const client = makeImportClient({ employees: ROSTER });
    mockCreateClient.mockResolvedValue(client as any);

    const res = await post({ csv });
    expect(await res.json()).toEqual({ imported: 1, skipped: 1, unmatched: [], errors: [] });
  });

  it("rejects shifts that fail shift-minute validation as row errors", async () => {
    // 30-minute shift violates the 1-hour minimum.
    const csv = "Employee Name,Date,Start Time,End Time\nBob Lee,07/06/2026,9:00 AM,9:30 AM";
    const client = makeImportClient({ employees: ROSTER });
    mockCreateClient.mockResolvedValue(client as any);

    const res = await post({ csv });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.imported).toBe(0);
    expect(json.errors).toEqual([
      { line: 2, message: expect.stringContaining("at least 1 hour") },
    ]);
    expect(client.insertSpy).not.toHaveBeenCalled();
  });

  it("carries parse errors for bad rows alongside imported ones", async () => {
    const csv = [
      "Employee Name,Date,Start Time,End Time",
      "Bob Lee,07/06/2026,9:00 AM,5:00 PM",
      "Jane Smith,not-a-date,9:00 AM,5:00 PM",
    ].join("\n");
    const res = await post({ csv });
    const json = await res.json();
    expect(json.imported).toBe(1);
    expect(json.errors).toEqual([{ line: 3, message: expect.stringContaining("not-a-date") }]);
  });

  it("returns 500 when the employees fetch fails", async () => {
    mockCreateClient.mockResolvedValue(
      makeImportClient({ employeesError: { message: "db down" } }) as any
    );
    const res = await post({ csv: CSV });
    expect(res.status).toBe(500);
  });

  it("returns 500 when the existing-schedules fetch fails", async () => {
    mockCreateClient.mockResolvedValue(
      makeImportClient({ employees: ROSTER, existingError: { message: "db down" } }) as any
    );
    const res = await post({ csv: CSV });
    expect(res.status).toBe(500);
  });

  it("returns 500 when the insert fails", async () => {
    mockCreateClient.mockResolvedValue(
      makeImportClient({ employees: ROSTER, insertError: { message: "insert failed" } }) as any
    );
    const res = await post({ csv: CSV });
    expect(res.status).toBe(500);
  });
});
