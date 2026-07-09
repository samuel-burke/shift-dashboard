import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { getOrgContext } from "@/lib/org-context";
import { withOrg } from "@/lib/org-scope";
import { writeAuditLog } from "@/lib/audit";
import {
  effectiveWeeklyHours,
  validatePreferredHours,
  isJobCode,
  type JobCode,
} from "@/lib/work-preference";

export const dynamic = "force-dynamic";

// GET /api/work-preferences?employeeId= — the employee's job code, their
// stored weekly-hours preference, and the effective hours the two combine to
// (full-time is always 40). Readable by any org member, like availability:
// managers need it when planning, coworkers seeing it is harmless.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const employeeIdStr = searchParams.get("employeeId");

  if (!employeeIdStr)
    return NextResponse.json({ error: "employeeId param required" }, { status: 400 });

  const employeeId = Number(employeeIdStr);
  if (!Number.isInteger(employeeId) || employeeId <= 0)
    return NextResponse.json({ error: "employeeId must be a positive integer" }, { status: 400 });

  const supabase = await createClient();
  const { ctx, error } = await getOrgContext(supabase, request);
  if (error === "Not authenticated")
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (error) return NextResponse.json({ error }, { status: 403 });

  const { orgId } = ctx!;

  const { data: employee, error: empError } = await supabase
    .from("employees")
    .select("id, job_code")
    .eq("org_id", orgId)
    .eq("id", employeeId)
    .maybeSingle();

  if (empError) {
    console.error("[api/work-preferences]", empError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  if (!employee)
    return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  const { data: pref, error: prefError } = await supabase
    .from("work_preferences")
    .select("preferred_hours")
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .maybeSingle();

  if (prefError) {
    console.error("[api/work-preferences]", prefError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const jobCode: JobCode = isJobCode(employee.job_code) ? employee.job_code : "part_time";
  const preferredHours = pref?.preferred_hours ?? null;

  return NextResponse.json({
    employeeId,
    jobCode,
    preferredHours,
    effectiveHours: effectiveWeeklyHours(jobCode, preferredHours),
  });
}

// PUT /api/work-preferences — set a part-time associate's preferred weekly
// hours. Employees set their own; managers may set anyone's. Full-time
// associates always work 40, so writing a preference for them is rejected.
export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  const { employeeId, preferredHours } = body ?? {};

  if (employeeId == null)
    return NextResponse.json({ error: "employeeId required" }, { status: 400 });
  if (!Number.isInteger(employeeId) || employeeId <= 0)
    return NextResponse.json({ error: "employeeId must be a positive integer" }, { status: 400 });

  const validationError = validatePreferredHours(preferredHours);
  if (validationError)
    return NextResponse.json({ error: validationError }, { status: 422 });

  const supabase = await createClient();
  const { ctx, error } = await getOrgContext(supabase, request);
  if (error === "Not authenticated")
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (error) return NextResponse.json({ error }, { status: 403 });

  const { orgId, user, isManager, employeeId: ctxEmployeeId } = ctx!;

  // Non-manager: may only set their own preference.
  if (!isManager && (!ctxEmployeeId || ctxEmployeeId !== employeeId))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: employee } = await supabase
    .from("employees")
    .select("id, name, job_code")
    .eq("org_id", orgId)
    .eq("id", employeeId)
    .maybeSingle();

  if (!employee)
    return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  if (employee.job_code === "full_time")
    return NextResponse.json(
      { error: "Full-time associates always work 40 hours per week" },
      { status: 422 }
    );

  const { error: upsertError } = await supabase
    .from("work_preferences")
    .upsert(
      withOrg(orgId, {
        employee_id: employeeId,
        preferred_hours: preferredHours,
        updated_at: new Date().toISOString(),
      }),
      { onConflict: "org_id,employee_id" }
    );

  if (upsertError) {
    console.error("[api/work-preferences]", upsertError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  writeAuditLog({
    action:       "work_preference.upsert",
    orgId,
    actorId:      user.id,
    resourceType: "work_preference",
    after: { employeeId, preferredHours },
    metadata: {
      employeeId,
      employeeName: employee.name,
      preferredHours,
      byManager: isManager,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
