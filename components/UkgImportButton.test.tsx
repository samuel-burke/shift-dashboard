import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import UkgImportButton from "./UkgImportButton";

const CSV = [
  "Employee Name,Date,Start Time,End Time",
  '"Smith, Jane",07/06/2026,9:00 AM,5:00 PM',
  "Bob Lee,07/06/2026,1:00 PM,9:00 PM",
].join("\n");

function makeCsvFile(contents: string, name = "schedule.csv"): File {
  const file = new File([contents], name, { type: "text/csv" });
  // jsdom's File lacks .text(); polyfill it for the component's read path.
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: () => Promise.resolve(contents) });
  }
  return file;
}

function pickFile(file: File) {
  const input = screen.getByTestId("ukg-import-file");
  fireEvent.change(input, { target: { files: [file] } });
}

describe("UkgImportButton", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the import button", () => {
    render(<UkgImportButton />);
    expect(screen.getByRole("button", { name: /import ukg schedule/i })).toBeInTheDocument();
  });

  it("shows a preview with the parsed shift count after picking a file", async () => {
    render(<UkgImportButton />);
    pickFile(makeCsvFile(CSV));
    expect(await screen.findByText("schedule.csv")).toBeInTheDocument();
    expect(screen.getByText(/2 shifts found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import 2 shifts/i })).toBeInTheDocument();
  });

  it("lists skipped rows in the preview when the file has bad rows", async () => {
    const csv = `${CSV}\nAnn Ray,bad-date,9:00 AM,5:00 PM`;
    render(<UkgImportButton />);
    pickFile(makeCsvFile(csv));
    expect(await screen.findByText(/1 row skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/line 4/i)).toBeInTheDocument();
  });

  it("shows an error when the file has no importable shifts", async () => {
    render(<UkgImportButton />);
    pickFile(makeCsvFile("Employee,Date\nBob,07/06/2026"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/missing required column/i);
  });

  it("cancel returns to the idle button without posting", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    render(<UkgImportButton />);
    pickFile(makeCsvFile(CSV));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("button", { name: /import ukg schedule/i })).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POSTs the raw csv on confirm and shows the server result", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ imported: 2, skipped: 1, unmatched: ["Ann Ray"], errors: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const onImported = vi.fn();

    render(<UkgImportButton onImported={onImported} />);
    pickFile(makeCsvFile(CSV));
    fireEvent.click(await screen.findByRole("button", { name: /import 2 shifts/i }));

    await waitFor(() => expect(screen.getByText(/imported 2 shifts/i)).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledWith("/api/schedules/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: CSV }),
    });
    expect(screen.getByText(/1 skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/ann ray/i)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalled();
  });

  it("shows the server error when the import fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: "Manager access required" }),
      })
    );
    render(<UkgImportButton />);
    pickFile(makeCsvFile(CSV));
    fireEvent.click(await screen.findByRole("button", { name: /import 2 shifts/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/manager access required/i);
  });

  it("does not call onImported when nothing was imported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ imported: 0, skipped: 2, unmatched: [], errors: [] }),
      })
    );
    const onImported = vi.fn();
    render(<UkgImportButton onImported={onImported} />);
    pickFile(makeCsvFile(CSV));
    fireEvent.click(await screen.findByRole("button", { name: /import 2 shifts/i }));
    await waitFor(() => expect(screen.getByText(/imported 0 shifts/i)).toBeInTheDocument());
    expect(onImported).not.toHaveBeenCalled();
  });
});
