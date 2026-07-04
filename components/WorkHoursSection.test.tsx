import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import WorkHoursSection from "./WorkHoursSection";

function mockFetchSequence({
  getResponse,
  putOk = true,
  putError = "Failed to save",
}: {
  getResponse: unknown;
  putOk?: boolean;
  putError?: string;
}) {
  const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PUT") {
      return { ok: putOk, json: async () => (putOk ? { ok: true } : { error: putError }) };
    }
    return { ok: true, json: async () => getResponse };
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

const PART_TIME = { employeeId: 1, jobCode: "part_time", preferredHours: 24, effectiveHours: 24 };
const FULL_TIME = { employeeId: 1, jobCode: "full_time", preferredHours: null, effectiveHours: 40 };

describe("WorkHoursSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a fixed 40 hours/week for full-time employees with no input", async () => {
    mockFetchSequence({ getResponse: FULL_TIME });
    render(<WorkHoursSection employeeId={1} />);
    expect(await screen.findByText(/40 hours \/ week/i)).toBeInTheDocument();
    expect(screen.getByText("Full-time")).toBeInTheDocument();
    expect(screen.queryByLabelText(/preferred hours/i)).not.toBeInTheDocument();
  });

  it("shows the stored preference in an editable input for part-time employees", async () => {
    mockFetchSequence({ getResponse: PART_TIME });
    render(<WorkHoursSection employeeId={1} />);
    const input = await screen.findByLabelText(/preferred hours per week/i);
    expect(input).toHaveValue(24);
    expect(screen.getByText("Part-time")).toBeInTheDocument();
  });

  it("PUTs the new preference and confirms the save", async () => {
    const mockFetch = mockFetchSequence({ getResponse: PART_TIME });
    render(<WorkHoursSection employeeId={1} />);
    const input = await screen.findByLabelText(/preferred hours per week/i);

    fireEvent.change(input, { target: { value: "32" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByText(/saved ✓/i)).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledWith("/api/work-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId: 1, preferredHours: 32 }),
    });
  });

  it("disables Save until the value actually changes", async () => {
    mockFetchSequence({ getResponse: PART_TIME });
    render(<WorkHoursSection employeeId={1} />);
    await screen.findByLabelText(/preferred hours per week/i);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("rejects out-of-range values with an inline error and no request", async () => {
    const mockFetch = mockFetchSequence({ getResponse: PART_TIME });
    render(<WorkHoursSection employeeId={1} />);
    const input = await screen.findByLabelText(/preferred hours per week/i);

    fireEvent.change(input, { target: { value: "50" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/between 1 and 40/i);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the initial GET
  });

  it("surfaces the server error when the save fails", async () => {
    mockFetchSequence({ getResponse: PART_TIME, putOk: false, putError: "Nope" });
    render(<WorkHoursSection employeeId={1} />);
    const input = await screen.findByLabelText(/preferred hours per week/i);

    fireEvent.change(input, { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
  });
});
