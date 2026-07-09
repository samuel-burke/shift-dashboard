import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import DesiredHoursSection from "./DesiredHoursSection";

function makeMockFetch(employees: any[] = []) {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(employees) });
  });
}

describe("DesiredHoursSection", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("loads the employee's current desired hours on mount", async () => {
    vi.stubGlobal("fetch", makeMockFetch([{ id: 1, desired_hours: 32 }, { id: 2, desired_hours: 8 }]));
    render(<DesiredHoursSection employeeId={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText("Desired weekly hours")).toHaveValue(32);
  });

  it("leaves the input blank when no preference is set", async () => {
    vi.stubGlobal("fetch", makeMockFetch([{ id: 1, desired_hours: null }]));
    render(<DesiredHoursSection employeeId={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText("Desired weekly hours")).toHaveValue(null);
  });

  it("saves the new value with a debounced PATCH", async () => {
    vi.useFakeTimers();
    const mockFetch = makeMockFetch([{ id: 1, desired_hours: null }]);
    vi.stubGlobal("fetch", mockFetch);
    render(<DesiredHoursSection employeeId={1} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.change(screen.getByLabelText("Desired weekly hours"), { target: { value: "24" } });
    expect(screen.getByText("Saving…")).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(900); await Promise.resolve(); });

    expect(mockFetch).toHaveBeenCalledWith("/api/employees", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ id: 1, desiredHours: 24 }),
    }));
    expect(screen.getByText("Saved ✓")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("clears the preference when the input is emptied", async () => {
    vi.useFakeTimers();
    const mockFetch = makeMockFetch([{ id: 1, desired_hours: 24 }]);
    vi.stubGlobal("fetch", mockFetch);
    render(<DesiredHoursSection employeeId={1} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.change(screen.getByLabelText("Desired weekly hours"), { target: { value: "" } });
    await act(async () => { vi.advanceTimersByTime(900); await Promise.resolve(); });

    expect(mockFetch).toHaveBeenCalledWith("/api/employees", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ id: 1, desiredHours: null }),
    }));
    vi.useRealTimers();
  });

  it("shows an error for out-of-range values without saving", async () => {
    vi.useFakeTimers();
    const mockFetch = makeMockFetch([{ id: 1, desired_hours: null }]);
    vi.stubGlobal("fetch", mockFetch);
    render(<DesiredHoursSection employeeId={1} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.change(screen.getByLabelText("Desired weekly hours"), { target: { value: "200" } });
    await act(async () => { vi.advanceTimersByTime(900); await Promise.resolve(); });

    expect(screen.getByText("Error")).toBeInTheDocument();
    const patchCalls = mockFetch.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PATCH");
    expect(patchCalls).toHaveLength(0);
    vi.useRealTimers();
  });
});
