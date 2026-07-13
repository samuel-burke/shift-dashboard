import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase-admin";
import { getOrgContext } from "@/lib/org-context";
import { writeAuditLog } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Schedule preferences an employee may set for themselves or a manager may
// set on their behalf (mirroring /api/availability's authorization). Kept
// separate from the manager-only PATCH /api/employees because RLS restricts
// employees-table writes to managers: after the self/manager check below,
// the self-service path performs the write with the service-role client.
export async function PATCH(request: Request) {
  const body = await request.json();
  const { employeeId, idealHours } = body;

  if (employeeId == null)
    return NextResponse.json({ error: "employeeId required" }, { status: 400 });
  if (!Number.isInteger(employeeId) || employeeId <= 0)
    return NextResponse.json({ error: "employeeId must be a positive integer" }, { status: 400 });
  if (idealHours === undefined)
    return NextResponse.json({ error: "idealHours required (null to clear)" }, { status: 400 });
  if (
    idealHours !== null &&
    (!Number.isInteger(idealHours) || idealHours < 0 || idealHours > 168)
  )
    return NextResponse.json(
      { error: "idealHours must be an integer between 0 and 168, or null to clear" },
      { status: 400 }
    );

  const supabase = await createClient();

  const { ctx, error } = await getOrgContext(supabase, request);
  if (error === "Not authenticated")
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (error) return NextResponse.json({ error }, { status: 403 });

  const { orgId, user, isManager, employeeId: ctxEmployeeId } = ctx!;

  if (!isManager && (!ctxEmployeeId || ctxEmployeeId !== employeeId))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: employee } = await supabase
    .from("employees")
    .select("id, name, ideal_hours")
    .eq("org_id", orgId)
    .eq("id", employeeId)
    .maybeSingle();

  if (!employee)
    return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  // Managers write through the RLS-scoped client; employees updating their
  // own row need the service-role client since RLS limits writes to managers.
  const writer = isManager ? supabase : createAdminClient();
  const { error: updateError } = await writer
    .from("employees")
    .update({ ideal_hours: idealHours })
    .eq("org_id", orgId)
    .eq("id", employeeId);

  if (updateError) {
    console.error("[api/schedule-preferences]", updateError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  writeAuditLog({
    action:       "ideal_hours.update",
    orgId,
    actorId:      user.id,
    resourceType: "employee",
    resourceId:   String(employeeId),
    before: { idealHours: employee.ideal_hours },
    after:  { idealHours },
    metadata: {
      employeeId,
      employeeName: employee.name,
      byManager: isManager,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
