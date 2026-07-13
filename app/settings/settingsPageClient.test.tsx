import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import SettingsPageClient from "./settingsPageClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

const DEFAULT_HOURS = {
  0: { open: 480,  close: 1200 },
  1: { open: 360,  close: 1320 },
  2: { open: 360,  close: 1320 },
  3: { open: 360,  close: 1320 },
  4: { open: 360,  close: 1320 },
  5: { open: 360,  close: 1320 },
  6: { open: 360,  close: 1320 },
};

const DEFAULT_SETTINGS = {
  firstDayOfWeek: 0,
  timezone: "America/New_York",
  emailNotifications: false,
  coverageAlertsEnabled: true,
  manualPunchesEnabled: true,
  gpsRequired: false,
};

function setupFetch({ putOk = true } = {}) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET") {
      if (url.includes("/api/store-hours"))
        return { ok: true, json: async () => DEFAULT_HOURS } as Response;
      if (url.includes("/api/settings"))
        return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
      if (url.includes("/api/employees"))
        return { ok: true, json: async () => [] } as Response;
      if (url.includes("/api/me"))
        return { ok: true, json: async () => ({ isManager: true, employeeId: null }) } as Response;
      if (url.includes("/api/availability"))
        return { ok: true, json: async () => [] } as Response;
    }

    return { ok: putOk, json: async () => ({}) } as Response;
  });
}

async function renderAndSettle() {
  render(<SettingsPageClient />);
  // Wait for store hours section to appear (signals initial fetches resolved)
  await screen.findByTestId("store-hours-section");
}

async function openStoreHoursSheet(dow: number) {
  const row = screen.getByTestId(`day-row-${dow}`);
  await act(async () => { fireEvent.click(row); });
  await act(async () => { await Promise.resolve(); });
}

describe("SettingsPageClient — auto-save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Store Hours ────────────────────────────────────────────────────────────

  describe("Store Hours", () => {
    it("does not render a 'Save Store Hours' button", async () => {
      setupFetch();
      await renderAndSettle();
      expect(screen.queryByRole("button", { name: /save store hours/i })).not.toBeInTheDocument();
    });

    it("PUT /api/store-hours for that day when open-time input is blurred", async () => {
      const fetchSpy = setupFetch();
      await renderAndSettle();
      await openStoreHoursSheet(0);

      const input = screen.getByLabelText("Sunday open time");
      await act(async () => {
        fireEvent.change(input, { target: { value: "09:00" } });
        fireEvent.blur(input);
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        const putCall = fetchSpy.mock.calls.find(
          ([url, opts]) =>
            url === "/api/store-hours" && opts?.method === "PUT"
        );
        expect(putCall).toBeTruthy();
        const body = JSON.parse(putCall![1]!.body as string);
        expect(body.dayOfWeek).toBe(0);
        expect(body.openMinutes).toBe(540); // 9*60
      });
    });

    it("PUT /api/store-hours for that day when close-time input is blurred", async () => {
      const fetchSpy = setupFetch();
      await renderAndSettle();
      await openStoreHoursSheet(1);

      const input = screen.getByLabelText("Monday close time");
      await act(async () => {
        fireEvent.change(input, { target: { value: "21:00" } });
        fireEvent.blur(input);
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        const putCall = fetchSpy.mock.calls.find(
          ([url, opts]) =>
            url === "/api/store-hours" && opts?.method === "PUT"
        );
        expect(putCall).toBeTruthy();
        const body = JSON.parse(putCall![1]!.body as string);
        expect(body.dayOfWeek).toBe(1);
        expect(body.closeMinutes).toBe(1260); // 21*60
      });
    });

    it("shows 'Saved ✓' in the day row after a successful save", async () => {
      setupFetch();
      await renderAndSettle();
      await openStoreHoursSheet(0);

      const input = screen.getByLabelText("Sunday open time");
      await act(async () => {
        fireEvent.change(input, { target: { value: "09:00" } });
        fireEvent.blur(input);
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByTestId("store-hours-status-0").textContent).toMatch(/Saved/);
      });
    });

    it("shows 'Failed to save' in the day row on API error", async () => {
      setupFetch({ putOk: false });
      await renderAndSettle();
      await openStoreHoursSheet(0);

      const input = screen.getByLabelText("Sunday open time");
      await act(async () => {
        fireEvent.change(input, { target: { value: "09:00" } });
        fireEvent.blur(input);
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByTestId("store-hours-status-0").textContent).toMatch(/Failed/);
      });
    });

    it("only saves the changed day, not all 7", async () => {
      const fetchSpy = setupFetch();
      await renderAndSettle();
      await openStoreHoursSheet(3);

      const input = screen.getByLabelText("Wednesday open time");
      await act(async () => {
        fireEvent.change(input, { target: { value: "07:00" } });
        fireEvent.blur(input);
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        const putCalls = fetchSpy.mock.calls.filter(
          ([url, opts]) => url === "/api/store-hours" && opts?.method === "PUT"
        );
        expect(putCalls).toHaveLength(1);
        const body = JSON.parse(putCalls[0][1]!.body as string);
        expect(body.dayOfWeek).toBe(3);
      });
    });
  });

  // ── Coverage Thresholds ────────────────────────────────────────────────────

  describe("Coverage Thresholds", () => {
    it("renders the coverage-profiles-link button for managers", async () => {
      setupFetch();
      await renderAndSettle();
      expect(screen.getByTestId("coverage-profiles-link")).toBeInTheDocument();
    });

    it("coverage-profiles-link is a button with accessible text", async () => {
      setupFetch();
      await renderAndSettle();
      const btn = screen.getByTestId("coverage-profiles-link");
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.textContent).toMatch(/Coverage Profiles/i);
    });

    it("coverage alerts toggle immediately calls PUT /api/settings", async () => {
      const fetchSpy = setupFetch();
      await renderAndSettle();

      await act(async () => {
        fireEvent.click(screen.getByRole("switch", { name: /coverage alerts/i }));
        await Promise.resolve();
      });

      await waitFor(() => {
        const putCall = fetchSpy.mock.calls.find(
          ([url, opts]) => url === "/api/settings" && opts?.method === "PUT"
        );
        expect(putCall).toBeTruthy();
        const body = JSON.parse(putCall![1]!.body as string);
        expect(body).toMatchObject({ coverageAlertsEnabled: false });
      });
    });

    it("does not render optimalCoverage or minCoverage steppers", async () => {
      setupFetch();
      await renderAndSettle();
      expect(screen.queryByTestId("coverage-optimal-plus")).not.toBeInTheDocument();
      expect(screen.queryByTestId("coverage-optimal-minus")).not.toBeInTheDocument();
    });
  });

  // ── Week Start ─────────────────────────────────────────────────────────────

  describe("Week Start", () => {
    it("does not render a standalone 'Save' button in the Week Start section", async () => {
      setupFetch();
      await renderAndSettle();
      // The only "Save" buttons remaining should be in employee name editing, not in week start
      expect(screen.queryByTestId("week-start-save-btn")).not.toBeInTheDocument();
    });

    it("immediately calls PUT /api/settings when a pill is clicked", async () => {
      const fetchSpy = setupFetch();
      await renderAndSettle();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Monday" }));
      });

      await waitFor(() => {
        const putCall = fetchSpy.mock.calls.find(
          ([url, opts]) => url === "/api/settings" && opts?.method === "PUT"
        );
        expect(putCall).toBeTruthy();
        const body = JSON.parse(putCall![1]!.body as string);
        expect(body.firstDayOfWeek).toBe(1);
      });
    });

    it("shows 'Saved ✓' after week start pill click succeeds", async () => {
      setupFetch();
      await renderAndSettle();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Monday" }));
      });

      await waitFor(() => {
        expect(screen.getByTestId("week-start-status").textContent).toMatch(/Saved/);
      });
    });

    it("shows 'Failed to save' when week start save fails", async () => {
      setupFetch({ putOk: false });
      await renderAndSettle();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Monday" }));
      });

      await waitFor(() => {
        expect(screen.getByTestId("week-start-status").textContent).toMatch(/Failed/);
      });
    });
  });

  // ── Timezone ───────────────────────────────────────────────────────────────

  describe("Timezone", () => {
    it("does not render a 'Save Timezone' button", async () => {
      setupFetch();
      await renderAndSettle();
      expect(screen.queryByRole("button", { name: /save timezone/i })).not.toBeInTheDocument();
    });

    it("immediately calls PUT /api/settings when select changes", async () => {
      const fetchSpy = setupFetch();
      await renderAndSettle();

      await act(async () => {
        fireEvent.change(screen.getByLabelText("Timezone"), {
          target: { value: "America/Chicago" },
        });
      });

      await waitFor(() => {
        const putCall = fetchSpy.mock.calls.find(
          ([url, opts]) => url === "/api/settings" && opts?.method === "PUT"
        );
        expect(putCall).toBeTruthy();
        const body = JSON.parse(putCall![1]!.body as string);
        expect(body.timezone).toBe("America/Chicago");
      });
    });

    it("shows 'Saved ✓' after timezone change succeeds", async () => {
      setupFetch();
      await renderAndSettle();

      await act(async () => {
        fireEvent.change(screen.getByLabelText("Timezone"), {
          target: { value: "America/Chicago" },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId("timezone-status").textContent).toMatch(/Saved/);
      });
    });

    it("shows 'Failed to save' when timezone save fails", async () => {
      setupFetch({ putOk: false });
      await renderAndSettle();

      await act(async () => {
        fireEvent.change(screen.getByLabelText("Timezone"), {
          target: { value: "America/Chicago" },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId("timezone-status").textContent).toMatch(/Failed/);
      });
    });
  });

});

// ── EmployeePreferencesRow (manager Settings) ─────────────────────────────

describe("EmployeePreferencesRow in SettingsPageClient", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function setupManagerFetch(availabilityRecords: any[] = [], employee: Record<string, unknown> = {}) {
    return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (url.includes("/api/store-hours")) return { ok: true, json: async () => DEFAULT_HOURS } as Response;
        if (url.includes("/api/settings"))   return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
        if (url.includes("/api/employees"))  return { ok: true, json: async () => [{ id: 5, name: "Alice Smith", email: "alice@test.com", user_id: null, ideal_hours: null, ...employee }] } as Response;
        if (url.includes("/api/me"))         return { ok: true, json: async () => ({ isManager: true }) } as Response;
        if (url.includes("/api/templates"))  return { ok: true, json: async () => ({ templates: [] }) } as Response;
        if (url.includes("/api/availability")) return { ok: true, json: async () => availabilityRecords } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  }

  async function renderAndExpand() {
    render(<SettingsPageClient />);
    await screen.findByTestId("store-hours-section");
    await waitFor(() => expect(screen.getByTestId("employee-avail-5")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle schedule preferences for Alice Smith" }));
      await Promise.resolve();
    });
    return within(screen.getByTestId("employee-avail-5"));
  }

  it("renders 'Schedule Preferences' toggle for each employee when manager", async () => {
    setupManagerFetch();
    render(<SettingsPageClient />);
    await screen.findByTestId("store-hours-section");
    await waitFor(() => expect(screen.getByTestId("employee-avail-5")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Toggle schedule preferences for Alice Smith" })).toBeInTheDocument();
  });

  it("shows the saved ideal hours in the collapsed summary", async () => {
    setupManagerFetch([], { ideal_hours: 20 });
    render(<SettingsPageClient />);
    await screen.findByTestId("store-hours-section");
    await waitFor(() => expect(screen.getByText(/20 hrs\/week/)).toBeInTheDocument());
  });

  it("expands to an editable availability section with all 7 day rows", async () => {
    setupManagerFetch([]);
    const row = await renderAndExpand();
    await waitFor(() => expect(row.getByTestId("availability-section")).toBeInTheDocument());
    expect(row.getAllByText("Any time").length).toBe(7);
  });

  it("shows 'Off' for unavailable days and time range for window records", async () => {
    setupManagerFetch([
      { id: 1, dayOfWeek: 0, startMinutes: null, endMinutes: null, note: null },
      { id: 2, dayOfWeek: 1, startMinutes: 720, endMinutes: 1320, note: null },
    ]);
    const row = await renderAndExpand();
    await waitFor(() => {
      expect(row.getByText("Off")).toBeInTheDocument();
      expect(row.getByText(/12:00 PM – 10:00 PM/)).toBeInTheDocument();
    });
  });

  it("saving the employee's availability POSTs /api/availability with their employeeId", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchSpy = setupManagerFetch([]);
    const row = await renderAndExpand();
    await waitFor(() => expect(row.getByTestId("availability-section")).toBeInTheDocument());

    await act(async () => { fireEvent.click(row.getByTestId("day-row-0")); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Off" }));
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const postCall = fetchSpy.mock.calls.find(
      ([url, opts]) => url === "/api/availability" && opts?.method === "POST"
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall![1]!.body as string);
    expect(body).toMatchObject({ employeeId: 5, dayOfWeek: 0, startMinutes: null, endMinutes: null });
    vi.useRealTimers();
  });

  it("editing ideal hours PATCHes /api/employees after the debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchSpy = setupManagerFetch([]);
    const row = await renderAndExpand();

    const input = row.getByLabelText("Ideal weekly hours for Alice Smith");
    await act(async () => {
      fireEvent.change(input, { target: { value: "25" } });
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const patchCall = fetchSpy.mock.calls.find(
      ([url, opts]) => url === "/api/employees" && opts?.method === "PATCH"
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(patchCall![1]!.body as string)).toEqual({ id: 5, idealHours: 25 });
    await waitFor(() => expect(row.getByText("Saved ✓")).toBeInTheDocument());
    vi.useRealTimers();
  });

  it("rejects out-of-range ideal hours without calling the API", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchSpy = setupManagerFetch([]);
    const row = await renderAndExpand();

    const input = row.getByLabelText("Ideal weekly hours for Alice Smith");
    await act(async () => {
      fireEvent.change(input, { target: { value: "200" } });
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    const patchCall = fetchSpy.mock.calls.find(
      ([url, opts]) => url === "/api/employees" && opts?.method === "PATCH"
    );
    expect(patchCall).toBeFalsy();
    await waitFor(() =>
      expect(row.getByText(/between 0 and 168/)).toBeInTheDocument()
    );
    vi.useRealTimers();
  });
});

// ── Employee (non-manager) view ───────────────────────────────────────────────

describe("SettingsPageClient — employee view", () => {
  function setupEmployeeFetch() {
    return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (url.includes("/api/me"))
          return { ok: true, json: async () => ({ isManager: false, employeeId: 5 }) } as Response;
        if (url.includes("/api/availability"))
          return { ok: true, json: async () => [] } as Response;
        if (url.includes("/api/settings"))
          return { ok: true, json: async () => DEFAULT_SETTINGS } as Response;
        if (url.includes("/api/employees"))
          return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  }

  beforeEach(() => { vi.clearAllMocks(); setupEmployeeFetch(); });
  afterEach(() => vi.restoreAllMocks());

  it("shows the availability section for a linked employee", async () => {
    render(<SettingsPageClient />);
    await screen.findByTestId("availability-section");
    expect(screen.getByText("Availability")).toBeInTheDocument();
  });

  it("hides Store Hours from employees", async () => {
    render(<SettingsPageClient />);
    await screen.findByTestId("availability-section");
    expect(screen.queryByTestId("store-hours-section")).not.toBeInTheDocument();
  });

  it("hides Coverage Thresholds from employees", async () => {
    render(<SettingsPageClient />);
    await screen.findByTestId("availability-section");
    expect(screen.queryByText(/coverage thresholds/i)).not.toBeInTheDocument();
  });

  it("hides the Employees management section from non-managers", async () => {
    render(<SettingsPageClient />);
    await screen.findByTestId("availability-section");
    expect(screen.queryByRole("button", { name: /add employee/i })).not.toBeInTheDocument();
  });

  it("shows the Sign Out button to all users", async () => {
    render(<SettingsPageClient />);
    await screen.findByTestId("availability-section");
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});
