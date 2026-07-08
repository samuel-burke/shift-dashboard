import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { requireManager } from "@/lib/require-manager";
import { writeAuditLog } from "@/lib/audit";
import { syncAutoDraftsForWeek } from "@/lib/auto-schedule-server";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/drafts/generate { weekStart } — auto-fill a week's draft schedule
// from the coverage curves. Existing manual drafts are kept and scheduled
// around; previously generated (auto) drafts are replaced. From this point the
// week is auto-managed: coverage, time-off, and call-out changes re-run the
// generator until the week is published.
export async function POST(request: Request) {
  const { weekStart } = await request.json();

  if (!weekStart)
    return NextResponse.json({ error: "weekStart required" }, { status: 400 });
  if (!DATE_RE.test(weekStart))
    return NextResponse.json({ error: "weekStart must be YYYY-MM-DD" }, { status: 400 });

  const supabase = await createClient();
  const { user, orgId, error: authError } = await requireManager(supabase, request);
  if (authError) return NextResponse.json({ error: authError }, { status: authError === "Not authenticated" ? 401 : 403 });

  let result;
  try {
    result = await syncAutoDraftsForWeek(supabase, orgId!, weekStart);
  } catch (e) {
    console.error("[api/drafts/generate]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  writeAuditLog({
    action:       "draft_schedule.auto_generate",
    orgId:        orgId!,
    actorId:      user?.id,
    resourceType: "draft_schedule",
    resourceId:   weekStart,
    after: { created: result!.created, removed: result!.removed, unfilledRanges: result!.unfilled.length },
    metadata: { weekStart },
  }).catch(() => {});

  return NextResponse.json(result);
}
