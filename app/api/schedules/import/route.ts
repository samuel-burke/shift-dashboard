import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";
import { requireManager } from "@/lib/require-manager";
import { writeAuditLog } from "@/lib/audit";
import { withOrgAll } from "@/lib/org-scope";
import { validateShiftMinutes } from "../validation";
import { parseUkgScheduleCsv, nameMatchKey, type ImportRowError } from "@/lib/ukg-import";

export const dynamic = "force-dynamic";

// UKG exports can be large, but a store schedule should never approach this.
const MAX_CSV_BYTES = 1_000_000;

// Imports a UKG (Kronos) schedule export. The client sends the raw CSV text;
// the server re-parses it (the browser preview uses the same lib/ukg-import
// parser, but this parse is the source of truth). Rows are matched to
// employees by name; unmatched names and employees already scheduled on a
// date are skipped and reported rather than failing the whole import.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const csv = body?.csv;

  if (typeof csv !== "string" || csv.trim() === "")
    return NextResponse.json({ error: "csv (non-empty string) required" }, { status: 400 });
  if (csv.length > MAX_CSV_BYTES)
    return NextResponse.json({ error: "csv exceeds the 1 MB import limit" }, { status: 413 });

  const supabase = await createClient();
  const { user, orgId, error: authError } = await requireManager(supabase, request);
  if (authError)
    return NextResponse.json(
      { error: authError },
      { status: authError === "Not authenticated" ? 401 : 403 }
    );

  const { shifts, errors: parseErrors } = parseUkgScheduleCsv(csv);
  const errors: ImportRowError[] = [...parseErrors];

  if (shifts.length === 0)
    return NextResponse.json(
      { error: "No importable shifts found in file", errors },
      { status: 422 }
    );

  // Match CSV names against the org's employees.
  const { data: employees, error: empError } = await supabase
    .from("employees")
    .select("id, name")
    .eq("org_id", orgId);
  if (empError) {
    console.error("[schedules/import] employees fetch failed:", empError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const employeeByKey = new Map<string, number>();
  for (const e of employees ?? []) employeeByKey.set(nameMatchKey(e.name), e.id);

  // One query for every schedule already on the file's dates, so each
  // (employee, date) pair can be dedupe-checked in memory.
  const dates = [...new Set(shifts.map((s) => s.date))];
  const { data: existing, error: existingError } = await supabase
    .from("schedules")
    .select("employee_id, date")
    .eq("org_id", orgId)
    .in("date", dates);
  if (existingError) {
    console.error("[schedules/import] existing schedules fetch failed:", existingError);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const taken = new Set(
    (existing ?? []).map((s: { employee_id: number; date: string }) => `${s.employee_id}:${s.date}`)
  );

  const unmatchedNames = new Set<string>();
  const rows: { employee_id: number; date: string; start_minutes: number; end_minutes: number }[] = [];
  let skipped = 0;

  for (const shift of shifts) {
    const employeeId = employeeByKey.get(nameMatchKey(shift.employeeName));
    if (employeeId === undefined) {
      unmatchedNames.add(shift.employeeName);
      continue;
    }

    const validationError = validateShiftMinutes(shift.startMinutes, shift.endMinutes);
    if (validationError) {
      errors.push({ line: shift.line, message: validationError });
      continue;
    }

    // Skip employees already scheduled that day — same one-shift-per-day rule
    // POST /api/schedules enforces. Also catches duplicates within the file.
    const key = `${employeeId}:${shift.date}`;
    if (taken.has(key)) {
      skipped++;
      continue;
    }
    taken.add(key);

    rows.push({
      employee_id: employeeId,
      date: shift.date,
      start_minutes: shift.startMinutes,
      end_minutes: shift.endMinutes,
    });
  }

  if (rows.length > 0) {
    const { error: insertError } = await supabase
      .from("schedules")
      .insert(withOrgAll(orgId, rows));
    if (insertError) {
      console.error("[schedules/import] schedules insert failed:", insertError);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  const unmatched = [...unmatchedNames];

  writeAuditLog({
    action:       "schedule.import",
    orgId,
    actorId:      user?.id,
    resourceType: "schedule",
    metadata: {
      source:    "ukg",
      imported:  rows.length,
      skipped,
      unmatched,
      rowErrors: errors.length,
    },
  }).catch(() => {});

  return NextResponse.json({ imported: rows.length, skipped, unmatched, errors });
}
