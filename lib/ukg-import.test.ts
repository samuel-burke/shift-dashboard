import { describe, it, expect } from "vitest";
import {
  parseCsvRecords,
  normalizeEmployeeName,
  nameMatchKey,
  parseUkgDate,
  parseUkgTime,
  parseUkgScheduleCsv,
} from "./ukg-import";

describe("parseCsvRecords", () => {
  it("splits simple rows and fields", () => {
    expect(parseCsvRecords("a,b,c\nd,e,f")).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("handles quoted fields containing commas and doubled quotes", () => {
    expect(parseCsvRecords('"Smith, Jane",x\n"He said ""hi""",y')).toEqual([
      ["Smith, Jane", "x"],
      ['He said "hi"', "y"],
    ]);
  });

  it("handles CRLF line endings and a trailing newline", () => {
    expect(parseCsvRecords("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles newlines inside quoted fields", () => {
    expect(parseCsvRecords('"line1\nline2",x')).toEqual([["line1\nline2", "x"]]);
  });
});

describe("normalizeEmployeeName", () => {
  it("passes 'First Last' through unchanged", () => {
    expect(normalizeEmployeeName("Jane Smith")).toBe("Jane Smith");
  });

  it("flips 'Last, First' to 'First Last'", () => {
    expect(normalizeEmployeeName("Smith, Jane")).toBe("Jane Smith");
  });

  it("collapses extra whitespace", () => {
    expect(normalizeEmployeeName("  Smith ,   Jane  ")).toBe("Jane Smith");
  });

  it("drops a dangling comma with no first name", () => {
    expect(normalizeEmployeeName("Smith,")).toBe("Smith");
  });
});

describe("nameMatchKey", () => {
  it("matches the same person across name orders and casing", () => {
    expect(nameMatchKey("SMITH, JANE")).toBe(nameMatchKey("jane smith"));
  });
});

describe("parseUkgDate", () => {
  it("parses MM/DD/YYYY", () => {
    expect(parseUkgDate("07/04/2026")).toBe("2026-07-04");
  });

  it("parses M/D/YYYY without zero padding", () => {
    expect(parseUkgDate("7/4/2026")).toBe("2026-07-04");
  });

  it("parses two-digit years as 20xx", () => {
    expect(parseUkgDate("7/4/26")).toBe("2026-07-04");
  });

  it("parses ISO YYYY-MM-DD", () => {
    expect(parseUkgDate("2026-07-04")).toBe("2026-07-04");
  });

  it("rejects impossible dates", () => {
    expect(parseUkgDate("02/30/2026")).toBeNull();
    expect(parseUkgDate("13/01/2026")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseUkgDate("Friday")).toBeNull();
    expect(parseUkgDate("")).toBeNull();
  });
});

describe("parseUkgTime", () => {
  it("parses 12-hour times", () => {
    expect(parseUkgTime("9:00 AM")).toBe(540);
    expect(parseUkgTime("1:30 PM")).toBe(810);
    expect(parseUkgTime("9:00am")).toBe(540);
    expect(parseUkgTime("9 AM")).toBe(540);
  });

  it("parses 12:00 AM as midnight and 12:00 PM as noon", () => {
    expect(parseUkgTime("12:00 AM")).toBe(0);
    expect(parseUkgTime("12:00 PM")).toBe(720);
  });

  it("parses 24-hour times", () => {
    expect(parseUkgTime("09:00")).toBe(540);
    expect(parseUkgTime("13:30")).toBe(810);
    expect(parseUkgTime("13:30:00")).toBe(810);
  });

  it("parses compact 24-hour times", () => {
    expect(parseUkgTime("0900")).toBe(540);
    expect(parseUkgTime("1330")).toBe(810);
  });

  it("treats 24:00 as end of day", () => {
    expect(parseUkgTime("24:00")).toBe(1440);
  });

  it("rejects invalid times", () => {
    expect(parseUkgTime("25:00")).toBeNull();
    expect(parseUkgTime("9:75")).toBeNull();
    expect(parseUkgTime("13:00 PM")).toBeNull();
    expect(parseUkgTime("noonish")).toBeNull();
    expect(parseUkgTime("")).toBeNull();
  });
});

describe("parseUkgScheduleCsv", () => {
  const HEADER = "Employee Name,Date,Start Time,End Time";

  it("parses a well-formed UKG export", () => {
    const csv = [
      HEADER,
      '"Smith, Jane",07/06/2026,9:00 AM,5:00 PM',
      "Bob Lee,07/06/2026,1:00 PM,9:00 PM",
    ].join("\n");
    const { shifts, errors } = parseUkgScheduleCsv(csv);
    expect(errors).toEqual([]);
    expect(shifts).toEqual([
      { employeeName: "Jane Smith", date: "2026-07-06", startMinutes: 540, endMinutes: 1020, line: 2 },
      { employeeName: "Bob Lee", date: "2026-07-06", startMinutes: 780, endMinutes: 1260, line: 3 },
    ]);
  });

  it("recognizes alternate header spellings", () => {
    const csv = "EMPLOYEE,Shift Date,Shift Start,Shift End\nBob Lee,2026-07-06,08:00,16:00";
    const { shifts, errors } = parseUkgScheduleCsv(csv);
    expect(errors).toEqual([]);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({ employeeName: "Bob Lee", date: "2026-07-06", startMinutes: 480, endMinutes: 960 });
  });

  it("reports missing required columns", () => {
    const { shifts, errors } = parseUkgScheduleCsv("Employee,Date\nBob,07/06/2026");
    expect(shifts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("start");
    expect(errors[0].message).toContain("end");
  });

  it("reports an empty file", () => {
    const { shifts, errors } = parseUkgScheduleCsv("");
    expect(shifts).toEqual([]);
    expect(errors).toEqual([{ line: 1, message: "File is empty" }]);
  });

  it("collects row errors without aborting the rest of the file", () => {
    const csv = [
      HEADER,
      "Bob Lee,07/06/2026,9:00 AM,5:00 PM",
      ",07/07/2026,9:00 AM,5:00 PM",
      "Ann Ray,bad-date,9:00 AM,5:00 PM",
      "Ann Ray,07/07/2026,nope,5:00 PM",
      "Ann Ray,07/07/2026,9:00 AM,never",
      "Ann Ray,07/08/2026,9:00 AM,5:00 PM",
    ].join("\n");
    const { shifts, errors } = parseUkgScheduleCsv(csv);
    expect(shifts.map((s) => s.line)).toEqual([2, 7]);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(errors[0].message).toContain("employee name");
    expect(errors[1].message).toContain("bad-date");
    expect(errors[2].message).toContain("nope");
    expect(errors[3].message).toContain("never");
  });

  it("rejects overnight shifts (end before start)", () => {
    const csv = `${HEADER}\nBob Lee,07/06/2026,10:00 PM,6:00 AM`;
    const { shifts, errors } = parseUkgScheduleCsv(csv);
    expect(shifts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("overnight");
  });

  it("skips blank rows", () => {
    const csv = `${HEADER}\n\nBob Lee,07/06/2026,9:00 AM,5:00 PM\n,,,\n`;
    const { shifts, errors } = parseUkgScheduleCsv(csv);
    expect(errors).toEqual([]);
    expect(shifts).toHaveLength(1);
  });

  it("skips leading blank rows before the header", () => {
    const csv = `\n${HEADER}\nBob Lee,07/06/2026,9:00 AM,5:00 PM`;
    const { shifts, errors } = parseUkgScheduleCsv(csv);
    expect(errors).toEqual([]);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].line).toBe(3);
  });
});
