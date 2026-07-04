"use client";

// An employee's weekly work-hours preference, shown in Settings → Preferences.
//
// Full-time associates always work FULL_TIME_WEEKLY_HOURS — the card just
// states that. Part-time associates pick their preferred weekly hours and
// save it via PUT /api/work-preferences.

import { useEffect, useState } from "react";
import {
  FULL_TIME_WEEKLY_HOURS,
  MIN_PREFERRED_HOURS,
  MAX_PREFERRED_HOURS,
  formatJobCode,
  type JobCode,
} from "@/lib/work-preference";

type Props = { employeeId: number };

export default function WorkHoursSection({ employeeId }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [jobCode, setJobCode] = useState<JobCode>("part_time");
  const [savedHours, setSavedHours] = useState<number | null>(null);
  const [inputVal, setInputVal] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/work-preferences?employeeId=${employeeId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (data.jobCode === "full_time" || data.jobCode === "part_time") setJobCode(data.jobCode);
        if (typeof data.preferredHours === "number") {
          setSavedHours(data.preferredHours);
          setInputVal(String(data.preferredHours));
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [employeeId]);

  const hours = Number(inputVal);
  const inputInvalid =
    inputVal !== "" &&
    (!Number.isInteger(hours) || hours < MIN_PREFERRED_HOURS || hours > MAX_PREFERRED_HOURS);
  const canSave =
    inputVal !== "" && !inputInvalid && hours !== savedHours && saveStatus !== "saving";

  async function save() {
    if (!canSave) return;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const res = await fetch("/api/work-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, preferredHours: hours }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Failed to save");
      }
      setSavedHours(hours);
      setSaveStatus("saved");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
      setSaveStatus("error");
    }
  }

  return (
    <section data-testid="work-hours-section">
      <div className="text-[11px] text-slate-400 font-semibold tracking-wider uppercase mb-2 px-1">
        Work Hours
      </div>
      <div className="bg-card rounded-2xl border border-slate-800/60 px-4 py-4">
        {!loaded ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-slate-400">Job code</span>
              <span
                className={`text-xs font-semibold px-3 py-1 rounded-full ${
                  jobCode === "full_time"
                    ? "bg-indigo-500/10 text-indigo-300 border border-indigo-500/30"
                    : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                }`}
              >
                {formatJobCode(jobCode)}
              </span>
            </div>

            {jobCode === "full_time" ? (
              <>
                <div className="text-2xl font-bold text-slate-100 mt-1">
                  {FULL_TIME_WEEKLY_HOURS} hours / week
                </div>
                <div className="text-xs text-slate-500 mt-1.5">
                  Full-time associates are always scheduled for {FULL_TIME_WEEKLY_HOURS} hours
                  per week.
                </div>
              </>
            ) : (
              <>
                <label
                  htmlFor="preferred-hours-input"
                  className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mt-3 mb-1.5"
                >
                  Preferred hours per week
                </label>
                <div className="flex gap-2">
                  <input
                    id="preferred-hours-input"
                    type="number"
                    inputMode="numeric"
                    min={MIN_PREFERRED_HOURS}
                    max={MAX_PREFERRED_HOURS}
                    value={inputVal}
                    onChange={(e) => {
                      setInputVal(e.target.value);
                      setSaveStatus("idle");
                      setSaveError(null);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") save(); }}
                    aria-invalid={inputInvalid || undefined}
                    aria-describedby={inputInvalid ? "preferred-hours-error" : undefined}
                    className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-xl px-3 py-3 text-slate-100 text-base outline-none focus:border-indigo-500/70 transition-colors"
                  />
                  <button
                    onClick={save}
                    disabled={!canSave}
                    aria-busy={saveStatus === "saving"}
                    className="px-5 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-violet-500 text-white font-bold text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                  >
                    {saveStatus === "saving" ? "Saving…" : "Save"}
                  </button>
                </div>
                {inputInvalid && (
                  <div id="preferred-hours-error" role="alert" className="text-xs text-red-400 mt-1.5">
                    Enter a whole number between {MIN_PREFERRED_HOURS} and {MAX_PREFERRED_HOURS}
                  </div>
                )}
                <div aria-live="polite" aria-atomic="true" className="mt-1.5 min-h-4">
                  {saveStatus === "saved" && (
                    <span className="text-xs text-emerald-400 font-semibold">Saved ✓</span>
                  )}
                  {saveStatus === "error" && saveError && (
                    <span role="alert" className="text-xs text-red-400">{saveError}</span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  How many hours you&apos;d ideally like to work each week. Managers see this
                  when planning the schedule.
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
