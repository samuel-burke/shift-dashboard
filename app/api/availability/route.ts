import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { getOrgContext } from "@/lib/org-context";
import { withOrg } from "@/lib/org-scope";
import { writeAuditLog } from "@/lib/audit";
import { notifyManagers } from "@/lib/notify";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Employee edits don't apply immediately — they file a change request that a
// manager approves (see /api/availability/requests). Replaces any pending
// request for the same day so the newest ask is the one managers see.
async function fileChangeRequest(
  supabase: Awaited<ReturnType<typeof createClient>>,
  args: {
    orgId: string;
    actorId: string;
    employeeId: number;
    employeeName: string | null;
    dayOfWeek: number;
    startMinutes: number | null;
    endMinutes: number | null;
    note: string | null;
    clear: boolean;
  }
) {
  const { orgId, actorId, employeeId, employeeName, dayOfWeek, startMinutes, endMinutes, note, clear } = args;

  await supabase
    .from("availability_change_requests")
    .delete()
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .eq("day_of_week", dayOfWeek)
    .eq("status", "pending");

  const { data: request, error: insertError } = await supabase
    .from("availability_change_requests")
    .insert(
      withOrg(orgId, {
        employee_id:             employeeId,
        day_of_week:             dayOfWeek,
        requested_start_minutes: startMinutes,
        requested_end_minutes:   endMinutes,
        requested_note:          note,
        requested_clear:         clear,
        created_by:              actorId,
      })
    )
    .select("id")
    .single();

  if (insertError || !request) {
    console.error("[api/availability]", insertError);
    return { response: NextResponse.json({ error: "Internal server error" }, { status: 500 }) };
  }

  const dayName = DAY_NAMES[dayOfWeek] ?? "";
  notifyManagers(
    supabase,
    orgId,
    "availability_request",
    "Availability Change Requested",
    `${employeeName ?? "An employee"} requested a change to their ${dayName} availability.`,
    { requestId: request.id, employeeId, dayOfWeek }
  ).catch(() => {});

  writeAuditLog({
    action:       "availability.request",
    orgId,
    actorId,
    resourceType: "availability_change_request",
    resourceId:   String(request.id),
    after: { employeeId, dayOfWeek, startMinutes, endMinutes, note, clear },
    metadata: {
      employeeId,
      employeeName,
      dayOfWeek,
      dayName: DAY_NAMES[dayOfWeek] ?? null,
    },
  }).catch(() => {});

  return { response: NextResponse.json({ ok: true, pending: true, requestId: request.id }) };
}

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
  if (error === "Not authenticated") {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (error) return NextResponse.json({ error }, { status: 403 });

  const { orgId } = ctx!;

  const { data, error: fetchError } = await supabase
    .from("availability")
    .select("id, day_of_week, start_minutes, end_minutes, note")
    .eq("org_id", orgId)
    .eq("employee_id", employeeId);

  if (fetchError) {
    console.error("[api/availability]", fetchError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const records = (data ?? []).map((row: {
    id: number;
    day_of_week: number;
    start_minutes: number | null;
    end_minutes: number | null;
    note: string | null;
  }) => ({
    id: row.id,
    dayOfWeek: row.day_of_week,
    startMinutes: row.start_minutes,
    endMinutes: row.end_minutes,
    note: row.note,
  }));
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { employeeId, dayOfWeek, startMinutes = null, endMinutes = null, note = null } = body;

  if (employeeId == null)
    return NextResponse.json({ error: "employeeId required" }, { status: 400 });
  if (dayOfWeek == null)
    return NextResponse.json({ error: "dayOfWeek required" }, { status: 400 });
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)
    return NextResponse.json({ error: "dayOfWeek must be an integer between 0 and 6" }, { status: 400 });

  // Validate window if both are provided (non-null)
  if (startMinutes !== null && endMinutes !== null) {
    if (startMinutes >= endMinutes)
      return NextResponse.json({ error: "startMinutes must be less than endMinutes" }, { status: 422 });
    if (endMinutes - startMinutes < 30)
      return NextResponse.json({ error: "Window must be at least 30 minutes" }, { status: 422 });
  }

  const supabase = await createClient();

  const { ctx, error } = await getOrgContext(supabase, request);
  if (error === "Not authenticated")
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (error)
    return NextResponse.json({ error }, { status: 403 });

  const { orgId, user, isManager, employeeId: ctxEmployeeId } = ctx!;

  let employeeName: string | null = null;
  if (!isManager) {
    // Non-manager: must be setting own availability
    if (!ctxEmployeeId || ctxEmployeeId !== employeeId)
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: linkedEmployee } = await supabase
      .from("employees")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("id", ctxEmployeeId)
      .maybeSingle();

    if (!linkedEmployee)
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    employeeName = linkedEmployee.name;

    // Employee self-edits need manager approval: file a change request
    // instead of writing to availability directly.
    const { response } = await fileChangeRequest(supabase, {
      orgId,
      actorId: user.id,
      employeeId,
      employeeName,
      dayOfWeek,
      startMinutes,
      endMinutes,
      note,
      clear: false,
    });
    return response;
  }

  const { data: emp } = await supabase
    .from("employees")
    .select("name")
    .eq("org_id", orgId)
    .eq("id", employeeId)
    .maybeSingle();
  employeeName = emp?.name ?? null;

  const { data: upserted, error: upsertError } = await supabase
    .from("availability")
    .upsert(
      withOrg(orgId, { employee_id: employeeId, day_of_week: dayOfWeek, start_minutes: startMinutes, end_minutes: endMinutes, note }),
      { onConflict: "employee_id,day_of_week" }
    )
    .select("id")
    .maybeSingle();

  if (upsertError) {
    console.error("[api/availability]", upsertError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  writeAuditLog({
    action:       "availability.upsert",
    orgId,
    actorId:      user.id,
    resourceType: "availability",
    after: { employeeId, dayOfWeek, startMinutes, endMinutes, note },
    metadata: {
      employeeId,
      employeeName,
      dayOfWeek,
      dayName: DAY_NAMES[dayOfWeek] ?? null,
      byManager: isManager,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true, id: upserted?.id ?? null });
}

export async function DELETE(request: Request) {
  const body = await request.json();
  const { id } = body;

  if (id == null)
    return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = await createClient();

  const { ctx, error } = await getOrgContext(supabase, request);
  if (error === "Not authenticated")
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (error)
    return NextResponse.json({ error }, { status: 403 });

  const { orgId, user, isManager, employeeId: ctxEmployeeId } = ctx!;

  // Fetch the availability record to check ownership — scoped to org
  const { data: record } = await supabase
    .from("availability")
    .select("id, employee_id, day_of_week")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();

  let employeeName: string | null = null;
  if (!isManager) {
    // Non-manager: must own the record
    if (!ctxEmployeeId || !record || ctxEmployeeId !== record.employee_id)
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: linkedEmployee } = await supabase
      .from("employees")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("id", ctxEmployeeId)
      .maybeSingle();

    if (!linkedEmployee)
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    employeeName = linkedEmployee.name;

    // Employee removing their own restriction ("any time") needs manager
    // approval too: file a clear request instead of deleting directly.
    const { response } = await fileChangeRequest(supabase, {
      orgId,
      actorId: user.id,
      employeeId: record.employee_id,
      employeeName,
      dayOfWeek: record.day_of_week,
      startMinutes: null,
      endMinutes: null,
      note: null,
      clear: true,
    });
    return response;
  } else if (record?.employee_id) {
    const { data: emp } = await supabase
      .from("employees")
      .select("name")
      .eq("org_id", orgId)
      .eq("id", record.employee_id)
      .maybeSingle();
    employeeName = emp?.name ?? null;
  }

  const { error: deleteError } = await supabase
    .from("availability")
    .delete()
    .eq("org_id", orgId)
    .eq("id", id);

  if (deleteError) {
    console.error("[api/availability]", deleteError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  writeAuditLog({
    action:       "availability.delete",
    orgId,
    actorId:      user.id,
    resourceType: "availability",
    resourceId:   String(id),
    before: record
      ? { employeeId: record.employee_id, dayOfWeek: record.day_of_week }
      : null,
    metadata: {
      employeeId:   record?.employee_id ?? null,
      employeeName,
      dayOfWeek:    record?.day_of_week ?? null,
      dayName:      record?.day_of_week != null ? DAY_NAMES[record.day_of_week] : null,
      byManager:    isManager,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
