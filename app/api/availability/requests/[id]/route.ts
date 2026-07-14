import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { requireManager } from "@/lib/require-manager";
import { getOrgContext } from "@/lib/org-context";
import { withOrg } from "@/lib/org-scope";
import { notify } from "@/lib/notify";
import { writeAuditLog } from "@/lib/audit";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Approve or deny an availability change request (manager only). Approval
// applies the requested state to the availability table before the request is
// marked decided, so a failed apply leaves the request pending.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || isNaN(id))
    return NextResponse.json({ error: "id must be an integer" }, { status: 400 });

  const { status } = await request.json();
  if (status !== "approved" && status !== "denied")
    return NextResponse.json(
      { error: 'status must be "approved" or "denied"' },
      { status: 400 }
    );

  const supabase = await createClient();
  const { user, orgId, error: authError } = await requireManager(supabase, request);
  if (authError)
    return NextResponse.json(
      { error: authError },
      { status: authError === "Not authenticated" ? 401 : 403 }
    );

  const { data: req } = await supabase
    .from("availability_change_requests")
    .select("id, employee_id, day_of_week, requested_start_minutes, requested_end_minutes, requested_note, requested_clear, status")
    .eq("org_id", orgId!)
    .eq("id", id)
    .maybeSingle();

  if (!req)
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if (req.status !== "pending")
    return NextResponse.json({ error: "Request has already been decided" }, { status: 409 });

  if (status === "approved") {
    if (req.requested_clear) {
      const { error: applyError } = await supabase
        .from("availability")
        .delete()
        .eq("org_id", orgId!)
        .eq("employee_id", req.employee_id)
        .eq("day_of_week", req.day_of_week);
      if (applyError) {
        console.error("[api/availability/requests/[id]]", applyError);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
      }
    } else {
      const { error: applyError } = await supabase
        .from("availability")
        .upsert(
          withOrg(orgId!, {
            employee_id:   req.employee_id,
            day_of_week:   req.day_of_week,
            start_minutes: req.requested_start_minutes,
            end_minutes:   req.requested_end_minutes,
            note:          req.requested_note,
          }),
          { onConflict: "employee_id,day_of_week" }
        );
      if (applyError) {
        console.error("[api/availability/requests/[id]]", applyError);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
      }
    }
  }

  const { error: updateError } = await supabase
    .from("availability_change_requests")
    .update({ status, decided_by: user!.id, decided_at: new Date().toISOString() })
    .eq("org_id", orgId!)
    .eq("id", id);

  if (updateError) {
    console.error("[api/availability/requests/[id]]", updateError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const dayName = DAY_NAMES[req.day_of_week] ?? "";

  // Notify the employee of the decision.
  const { data: emp } = await supabase
    .from("employees")
    .select("user_id, name")
    .eq("org_id", orgId!)
    .eq("id", req.employee_id)
    .maybeSingle();
  if (emp?.user_id) {
    notify(supabase, {
      orgId: orgId!,
      userId: emp.user_id,
      type: status === "approved" ? "availability_approved" : "availability_denied",
      title: status === "approved" ? "Availability Change Approved" : "Availability Change Denied",
      body: status === "approved"
        ? `Your ${dayName} availability change has been approved.`
        : `Your ${dayName} availability change was denied.`,
      data: { requestId: id, dayOfWeek: req.day_of_week },
    }).catch(() => {});
  }

  writeAuditLog({
    action:       status === "approved" ? "availability_request.approve" : "availability_request.deny",
    orgId:        orgId!,
    actorId:      user?.id,
    resourceType: "availability_change_request",
    resourceId:   String(id),
    before:       { status: "pending" },
    after: {
      status,
      startMinutes: req.requested_start_minutes,
      endMinutes:   req.requested_end_minutes,
      clear:        req.requested_clear,
    },
    metadata: {
      employeeId:   req.employee_id,
      employeeName: emp?.name ?? null,
      dayOfWeek:    req.day_of_week,
      dayName,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}

// Cancel a pending request — the requesting employee (own) or any manager.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || isNaN(id))
    return NextResponse.json({ error: "id must be an integer" }, { status: 400 });

  const supabase = await createClient();

  const { ctx, error } = await getOrgContext(supabase, request);
  if (error === "Not authenticated")
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (error) return NextResponse.json({ error }, { status: 403 });

  const { orgId, user, isManager, employeeId: ctxEmployeeId } = ctx!;

  const { data: req } = await supabase
    .from("availability_change_requests")
    .select("id, employee_id, day_of_week, status")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (!req)
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if (!isManager && (!ctxEmployeeId || ctxEmployeeId !== req.employee_id))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (req.status !== "pending")
    return NextResponse.json({ error: "Request has already been decided" }, { status: 409 });

  const { error: deleteError } = await supabase
    .from("availability_change_requests")
    .delete()
    .eq("org_id", orgId)
    .eq("id", id);

  if (deleteError) {
    console.error("[api/availability/requests/[id]]", deleteError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  writeAuditLog({
    action:       "availability_request.cancel",
    orgId,
    actorId:      user.id,
    resourceType: "availability_change_request",
    resourceId:   String(id),
    before:       { status: "pending" },
    metadata: {
      employeeId: req.employee_id,
      dayOfWeek:  req.day_of_week,
      dayName:    DAY_NAMES[req.day_of_week] ?? null,
      byManager:  isManager,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
