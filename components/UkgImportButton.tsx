"use client";

// Manager-only entry point for importing a UKG (Kronos) schedule export.
// Flow: pick a .csv → parse it locally with lib/ukg-import for a preview →
// confirm → POST the raw CSV to /api/schedules/import (the server re-parses;
// it is the source of truth) → show the imported/skipped/unmatched result.

import { useRef, useState } from "react";
import { parseUkgScheduleCsv, type ParseResult } from "@/lib/ukg-import";

type ImportResult = {
  imported: number;
  skipped: number;
  unmatched: string[];
  errors: { line: number; message: string }[];
};

type Phase =
  | { step: "idle" }
  | { step: "preview"; fileName: string; csv: string; parsed: ParseResult }
  | { step: "importing" }
  | { step: "done"; result: ImportResult }
  | { step: "error"; message: string };

export default function UkgImportButton({ onImported }: { onImported?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });

  async function handleFile(file: File) {
    try {
      const csv = await file.text();
      const parsed = parseUkgScheduleCsv(csv);
      if (parsed.shifts.length === 0) {
        setPhase({
          step: "error",
          message: parsed.errors[0]?.message ?? "No shifts found in file",
        });
        return;
      }
      setPhase({ step: "preview", fileName: file.name, csv, parsed });
    } catch {
      setPhase({ step: "error", message: "Couldn't read file" });
    }
  }

  async function confirmImport(csv: string) {
    setPhase({ step: "importing" });
    try {
      const res = await fetch("/api/schedules/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      setPhase({ step: "done", result: json });
      if (json.imported > 0) onImported?.();
    } catch (e) {
      setPhase({ step: "error", message: e instanceof Error ? e.message : "Import failed" });
    }
  }

  const pickerButton = (label: string) => (
    <button
      onClick={() => inputRef.current?.click()}
      className="w-full mt-3 py-3 text-sm font-bold text-slate-200 bg-card border border-slate-800/60 rounded-xl cursor-pointer hover:border-indigo-500/50 transition-colors"
    >
      {label}
    </button>
  );

  return (
    <div data-testid="ukg-import">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label="Choose UKG schedule export file"
        data-testid="ukg-import-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so re-selecting the same file fires onChange again.
          e.target.value = "";
          if (file) handleFile(file);
        }}
      />

      {phase.step === "idle" && pickerButton("Import UKG schedule")}

      {phase.step === "preview" && (
        <div className="mt-3 bg-card border border-slate-800/60 rounded-xl px-4 py-3">
          <div className="text-sm font-semibold text-slate-200">{phase.fileName}</div>
          <div className="text-sm text-slate-400 mt-1">
            {phase.parsed.shifts.length} shift{phase.parsed.shifts.length === 1 ? "" : "s"} found
            {phase.parsed.errors.length > 0 && (
              <span className="text-amber-400"> · {phase.parsed.errors.length} row{phase.parsed.errors.length === 1 ? "" : "s"} skipped</span>
            )}
          </div>
          {phase.parsed.errors.length > 0 && (
            <ul className="mt-1.5 text-xs text-amber-400/90 space-y-0.5 max-h-24 overflow-y-auto">
              {phase.parsed.errors.slice(0, 5).map((err) => (
                <li key={err.line}>Line {err.line}: {err.message}</li>
              ))}
              {phase.parsed.errors.length > 5 && <li>…and {phase.parsed.errors.length - 5} more</li>}
            </ul>
          )}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => confirmImport(phase.csv)}
              className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-violet-500 text-white font-bold text-sm cursor-pointer hover:opacity-90 transition-opacity"
            >
              Import {phase.parsed.shifts.length} shift{phase.parsed.shifts.length === 1 ? "" : "s"}
            </button>
            <button
              onClick={() => setPhase({ step: "idle" })}
              className="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 border border-slate-700 font-semibold text-sm cursor-pointer hover:bg-slate-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.step === "importing" && (
        <div role="status" aria-live="polite" className="mt-3 text-sm text-slate-400 text-center py-3">
          Importing…
        </div>
      )}

      {phase.step === "done" && (
        <div className="mt-3 bg-card border border-slate-800/60 rounded-xl px-4 py-3">
          <div role="status" aria-live="polite" className="text-sm text-emerald-400 font-semibold">
            Imported {phase.result.imported} shift{phase.result.imported === 1 ? "" : "s"} ✓
          </div>
          {phase.result.skipped > 0 && (
            <div className="text-xs text-slate-400 mt-1">
              {phase.result.skipped} skipped (already scheduled)
            </div>
          )}
          {phase.result.unmatched.length > 0 && (
            <div className="text-xs text-amber-400 mt-1">
              No matching employee: {phase.result.unmatched.join(", ")}
            </div>
          )}
          {phase.result.errors.length > 0 && (
            <div className="text-xs text-amber-400 mt-1">
              {phase.result.errors.length} row{phase.result.errors.length === 1 ? "" : "s"} could not be imported
            </div>
          )}
          {pickerButton("Import another file")}
        </div>
      )}

      {phase.step === "error" && (
        <div className="mt-3 bg-card border border-red-500/30 rounded-xl px-4 py-3">
          <div role="alert" className="text-sm text-red-400">{phase.message}</div>
          {pickerButton("Try another file")}
        </div>
      )}
    </div>
  );
}
