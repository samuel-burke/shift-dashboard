"use client";

import { useRef, useState } from "react";

type SaveStatus = "idle" | "saving" | "saved" | "error";

// Debounced editor for an employee's ideal weekly hours. Used by managers
// (Settings → Team) and by employees for their own preferences; the
// schedule-preferences API authorizes self-or-manager.
export default function IdealHoursEditor({
  employeeId,
  initialValue,
  ariaLabel,
  onSaved,
}: {
  employeeId: number;
  initialValue: number | null;
  ariaLabel: string;
  onSaved?: (idealHours: number | null) => void;
}) {
  const [val, setVal] = useState(initialValue != null ? String(initialValue) : "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleSave(raw: string) {
    setVal(raw);
    setStatus("saving");
    setError(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(raw), 800);
  }

  async function save(raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 168)) {
      setStatus("error");
      setError("Enter a whole number of hours between 0 and 168");
      return;
    }
    const res = await fetch("/api/schedule-preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, idealHours: value }),
    }).catch(() => null);
    if (res?.ok) {
      setStatus("saved");
      onSaved?.(value);
      setTimeout(() => setStatus("idle"), 2000);
    } else {
      setStatus("error");
      const json = await res?.json().catch(() => ({}));
      setError(json?.error ?? "Failed to save");
    }
  }

  return (
    <div className="flex items-center gap-3">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={168}
        step={1}
        placeholder="Not set"
        aria-label={ariaLabel}
        value={val}
        onChange={(e) => scheduleSave(e.target.value)}
        className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500/70 transition-colors"
      />
      <span className="text-xs text-slate-500">hours per week</span>
      <div aria-live="polite" className="ml-auto text-xs">
        {status === "saving" && <span className="text-slate-400">Saving…</span>}
        {status === "saved"  && <span className="text-emerald-400">Saved ✓</span>}
        {status === "error"  && <span role="alert" className="text-red-400">{error ?? "Failed to save"}</span>}
      </div>
    </div>
  );
}
