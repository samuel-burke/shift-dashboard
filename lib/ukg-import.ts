// Parses a UKG (Kronos) schedule export CSV into shift rows ShiftView can
// import. UKG Workforce Central / Dimensions exports vary by tenant config, so
// the parser is deliberately tolerant:
//   * header names are matched against known aliases (e.g. "Employee Name",
//     "Employee", "Name" all identify the employee column)
//   * dates accept MM/DD/YYYY, M/D/YY, and YYYY-MM-DD
//   * times accept 12-hour ("9:00 AM", "9:00am", "9 AM") and 24-hour ("09:00",
//     "1330") forms
//   * employee names in "Last, First" order are flipped to "First Last"
//
// The parser is pure and isomorphic: the browser uses it to preview a file
// before upload, and the API route re-parses the same CSV server-side as the
// source of truth.

export type ParsedShift = {
  /** As written in the file, normalized to "First Last" word order. */
  employeeName: string;
  /** YYYY-MM-DD */
  date: string;
  startMinutes: number;
  endMinutes: number;
  /** 1-based line number in the CSV, for error reporting. */
  line: number;
};

export type ImportRowError = { line: number; message: string };

export type ParseResult = {
  shifts: ParsedShift[];
  errors: ImportRowError[];
};

// Aliases are compared against lowercased headers with non-alphanumerics
// stripped, so "Start Time", "START_TIME", and "start-time" all match.
const HEADER_ALIASES: Record<"employee" | "date" | "start" | "end", string[]> = {
  employee: ["employee", "employeename", "name", "person", "personname", "fullname"],
  date: ["date", "startdate", "scheduledate", "shiftdate", "workdate", "day"],
  start: ["starttime", "start", "shiftstart", "intime", "in", "begintime", "scheduledstart"],
  end: ["endtime", "end", "shiftend", "outtime", "out", "finishtime", "scheduledend"],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Minimal RFC 4180 CSV: quoted fields may contain commas, newlines, and
// doubled quotes. Returns one string[] per record.
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRecord(); i++; continue; }
    field += c;
    i++;
  }
  // Flush the last record unless the file ended cleanly on a newline.
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/**
 * Flips "Last, First" to "First Last" and collapses whitespace. Names already
 * in "First Last" order pass through unchanged.
 */
export function normalizeEmployeeName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const comma = trimmed.indexOf(",");
  if (comma === -1) return trimmed;
  const last = trimmed.slice(0, comma).trim();
  const first = trimmed.slice(comma + 1).trim();
  if (!first || !last) return trimmed.replace(/,/g, "").trim();
  return `${first} ${last}`;
}

/** Case- and whitespace-insensitive key for matching names across systems. */
export function nameMatchKey(name: string): string {
  return normalizeEmployeeName(name).toLowerCase();
}

/** Parses MM/DD/YYYY, M/D/YY, or YYYY-MM-DD into "YYYY-MM-DD"; null if invalid. */
export function parseUkgDate(raw: string): string | null {
  const s = raw.trim();

  let y: number, m: number, d: number;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (us) {
    m = Number(us[1]);
    d = Number(us[2]);
    y = Number(us[3]);
    if (y < 100) y += 2000;
  } else {
    return null;
  }

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-trip through Date to reject impossible days like 02/30.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parses a time-of-day into minutes since midnight; null if invalid.
 * Accepts "9:00 AM", "9:00AM", "9 AM", "9AM", "09:00", "1330", "13:30:00".
 */
export function parseUkgTime(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/) ??
    // Compact 24-hour form without a separator ("0900", "1330").
    s.match(/^(\d{2})(\d{2})()$/);
  if (!m) return null;

  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3] || null;

  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (meridiem.startsWith("p")) hours += 12;
  } else if (hours > 23) {
    // 24:00 exactly means end-of-day.
    if (hours === 24 && minutes === 0) return 1440;
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * Parses a UKG schedule export CSV. Returns every parseable shift plus a
 * per-row error list; a malformed row never aborts the rest of the file.
 */
export function parseUkgScheduleCsv(text: string): ParseResult {
  const records = parseCsvRecords(text);
  const shifts: ParsedShift[] = [];
  const errors: ImportRowError[] = [];

  const nonEmpty = (r: string[]) => r.some((cell) => cell.trim() !== "");
  const headerIndex = records.findIndex(nonEmpty);
  if (headerIndex === -1) {
    return { shifts, errors: [{ line: 1, message: "File is empty" }] };
  }

  const header = records[headerIndex].map(normalizeHeader);
  const columnOf = (key: keyof typeof HEADER_ALIASES): number =>
    header.findIndex((h) => HEADER_ALIASES[key].includes(h));

  const cols = {
    employee: columnOf("employee"),
    date: columnOf("date"),
    start: columnOf("start"),
    end: columnOf("end"),
  };
  const missing = (Object.keys(cols) as (keyof typeof cols)[]).filter((k) => cols[k] === -1);
  if (missing.length > 0) {
    return {
      shifts,
      errors: [{
        line: headerIndex + 1,
        message: `Missing required column(s): ${missing.join(", ")}. Expected headers like "Employee Name", "Date", "Start Time", "End Time".`,
      }],
    };
  }

  for (let r = headerIndex + 1; r < records.length; r++) {
    const record = records[r];
    if (!nonEmpty(record)) continue;
    const line = r + 1;

    const rawName = (record[cols.employee] ?? "").trim();
    const rawDate = (record[cols.date] ?? "").trim();
    const rawStart = (record[cols.start] ?? "").trim();
    const rawEnd = (record[cols.end] ?? "").trim();

    if (!rawName) { errors.push({ line, message: "Missing employee name" }); continue; }

    const date = parseUkgDate(rawDate);
    if (!date) { errors.push({ line, message: `Invalid date "${rawDate}"` }); continue; }

    const startMinutes = parseUkgTime(rawStart);
    if (startMinutes === null) { errors.push({ line, message: `Invalid start time "${rawStart}"` }); continue; }

    const endMinutes = parseUkgTime(rawEnd);
    if (endMinutes === null) { errors.push({ line, message: `Invalid end time "${rawEnd}"` }); continue; }

    if (endMinutes <= startMinutes) {
      errors.push({ line, message: "Shift end must be after its start (overnight shifts are not supported)" });
      continue;
    }

    shifts.push({
      employeeName: normalizeEmployeeName(rawName),
      date,
      startMinutes,
      endMinutes,
      line,
    });
  }

  return { shifts, errors };
}
