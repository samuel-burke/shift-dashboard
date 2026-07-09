"use client";

import { useEffect, useRef, useState } from "react";

type Props = { employeeId: number };

// Desired weekly hours — a scheduling preference the auto-scheduler aims for
// when generating draft schedules. Employees set their own (like
// availability); managers can also set it for anyone via the employees API.
export default function DesiredHoursSection({ employeeId }: Props) {
  const [value, setValue] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/employees")
      .then((r) => r.json())
      .then((rows: { id: number; desired_hours?: number | null }[]) => {
        if (!Array.isArray(rows)) return;
        const me = rows.find((r) => r.id === employeeId);
        if (me?.desired_hours != null) setValue(String(me.desired_hours));
      })
      .catch(() => {});
  }, [employeeId]);

  function scheduleSave(next: string) {
    setValue(next);
    setSaveStatus("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSave(next), 800);
  }

  async function doSave(next: string) {
    const parsed = next.trim() === "" ? null : Number(next);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 80)) {
      setSaveStatus("error");
      return;
    }
    try {
      const res = await fetch("/api/employees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: employeeId, desiredHours: parsed }),
      });
      setSaveStatus(res.ok ? "saved" : "error");
    } catch {
      setSaveStatus("error");
    }
  }

  return (
    <section data-testid="desired-hours-section">
      <div className="text-[11px] text-slate-400 font-semibold tracking-wider uppercase mb-2 px-1">
        Desired Weekly Hours
      </div>
      <div className="bg-card rounded-2xl border border-slate-800/60 px-4 py-4">
        <div className="flex items-center gap-3">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={80}
            step={1}
            value={value}
            onChange={(e) => scheduleSave(e.target.value)}
            placeholder="—"
            aria-label="Desired weekly hours"
            className="w-20 bg-bg border border-slate-700 rounded-xl px-3 py-3 text-slate-100 text-base text-center tabular-nums outline-none focus:border-indigo-500/70 transition-colors"
          />
          <span className="text-sm text-slate-400">hours per week</span>
          <span role="status" aria-live="polite" aria-atomic="true" className="ml-auto shrink-0">
            {saveStatus === "saving" && <span className="text-[11px] text-slate-500">Saving…</span>}
            {saveStatus === "saved" && <span className="text-[11px] text-emerald-400">Saved ✓</span>}
            {saveStatus === "error" && <span className="text-[11px] text-red-400">Error</span>}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Auto-generated schedules aim for this many hours each week. Leave blank for no preference.
        </p>
      </div>
    </section>
  );
}
