import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { getOrgContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

type RequestRow = {
  id: number;
  employee_id: number;
  day_of_week: number;
  requested_start_minutes: number | null;
  requested_end_minutes: number | null;
  requested_note: string | null;
  requested_clear: boolean;
  status: string;
  created_at: string;
};

// Pending availability change requests. Managers see the whole org's (or one
// employee's with ?employeeId=); employees see only their own.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const employeeIdParam = searchParams.get("employeeId");

  const supabase = await createClient();

  const { ctx, error } = await getOrgContext(supabase, request);
  if (error === "Not authenticated")
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (error) return NextResponse.json({ error }, { status: 403 });

  const { orgId, isManager, employeeId: ctxEmployeeId } = ctx!;

  let employeeFilter: number | null = null;
  if (isManager) {
    if (employeeIdParam !== null) {
      const parsed = Number(employeeIdParam);
      if (!Number.isInteger(parsed) || parsed <= 0)
        return NextResponse.json({ error: "employeeId must be a positive integer" }, { status: 400 });
      employeeFilter = parsed;
    }
  } else {
    // Employees only ever see their own requests.
    if (!ctxEmployeeId) return NextResponse.json({ requests: [] });
    employeeFilter = ctxEmployeeId;
  }

  let query = supabase
    .from("availability_change_requests")
    .select("id, employee_id, day_of_week, requested_start_minutes, requested_end_minutes, requested_note, requested_clear, status, created_at")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (employeeFilter !== null) query = query.eq("employee_id", employeeFilter);

  const { data, error: fetchError } = await query;
  if (fetchError) {
    console.error("[api/availability/requests]", fetchError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const rows = (data ?? []) as RequestRow[];

  // Attach employee names for the manager's approval cards.
  const employeeIds = [...new Set(rows.map((r) => r.employee_id))];
  const nameById: Record<number, string> = {};
  if (employeeIds.length > 0) {
    const { data: employees } = await supabase
      .from("employees")
      .select("id, name")
      .eq("org_id", orgId)
      .in("id", employeeIds);
    for (const emp of Array.isArray(employees) ? employees : []) nameById[emp.id] = emp.name;
  }

  return NextResponse.json({
    requests: rows.map((r) => ({
      id:           r.id,
      employeeId:   r.employee_id,
      employeeName: nameById[r.employee_id] ?? "Unknown",
      dayOfWeek:    r.day_of_week,
      startMinutes: r.requested_start_minutes,
      endMinutes:   r.requested_end_minutes,
      note:         r.requested_note,
      clear:        r.requested_clear,
      status:       r.status,
      createdAt:    r.created_at,
    })),
  });
}
