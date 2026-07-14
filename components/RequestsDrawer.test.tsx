import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import RequestsDrawer from "./RequestsDrawer";

const SWAPS = [
  {
    id: 7,
    requesterName: "Alex Kim",
    targetName: "Jordan Lee",
    date: "2026-06-22",
    scheduleATime: "9:00 AM – 5:00 PM",
    scheduleBTime: "12:00 PM – 8:00 PM",
  },
];

const TIME_OFF = [
  { id: 3, employeeName: "Sam Rivera", date: "2026-06-25", note: "Doctor" },
];

const AVAILABILITY = [
  {
    id: 11,
    employeeName: "Casey Fox",
    dayOfWeek: 1,
    startMinutes: 720,
    endMinutes: 1320,
    note: "Class in the morning",
    clear: false,
  },
];

const BASE = {
  open: true,
  onClose: () => {},
  swaps: SWAPS,
  timeOff: TIME_OFF,
  availability: AVAILABILITY,
  onApproveSwap: () => Promise.resolve(),
  onDenySwap: () => Promise.resolve(),
  onApproveTimeOff: () => Promise.resolve(),
  onDenyTimeOff: () => Promise.resolve(),
  onApproveAvailability: () => Promise.resolve(),
  onDenyAvailability: () => Promise.resolve(),
};

describe("RequestsDrawer", () => {
  it("does not render when closed", () => {
    render(<RequestsDrawer {...BASE} open={false} />);
    expect(screen.queryByTestId("requests-drawer")).not.toBeInTheDocument();
  });

  it("renders all sections with their headings and items", () => {
    render(<RequestsDrawer {...BASE} />);
    expect(screen.getByText("Time Off")).toBeInTheDocument();
    expect(screen.getByText("Shift Swaps")).toBeInTheDocument();
    expect(screen.getByText("Availability Changes")).toBeInTheDocument();
    expect(screen.getByText("Sam Rivera")).toBeInTheDocument();
    expect(screen.getByText("Casey Fox")).toBeInTheDocument();
    expect(screen.getByText(/Alex Kim wants to swap with Jordan Lee/i)).toBeInTheDocument();
  });

  it("shows the total awaiting-approval count", () => {
    render(<RequestsDrawer {...BASE} />);
    expect(screen.getByText("3 awaiting approval")).toBeInTheDocument();
  });

  it("shows an empty state and hides all sections when there are no requests", () => {
    render(<RequestsDrawer {...BASE} swaps={[]} timeOff={[]} availability={[]} />);
    expect(screen.getByText("No pending requests")).toBeInTheDocument();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByText("Time Off")).not.toBeInTheDocument();
    expect(screen.queryByText("Shift Swaps")).not.toBeInTheDocument();
    expect(screen.queryByText("Availability Changes")).not.toBeInTheDocument();
  });

  it("hides the time-off section when there are no time-off requests", () => {
    render(<RequestsDrawer {...BASE} timeOff={[]} />);
    expect(screen.queryByText("Time Off")).not.toBeInTheDocument();
    expect(screen.getByText("Shift Swaps")).toBeInTheDocument();
  });

  // Each card disables both buttons while an action is in flight, so approve and
  // deny are exercised in separate renders.
  it("calls onApproveSwap with the swap id", async () => {
    const onApproveSwap = vi.fn().mockResolvedValue(undefined);
    render(<RequestsDrawer {...BASE} onApproveSwap={onApproveSwap} />);
    fireEvent.click(screen.getByLabelText(/Approve swap between Alex Kim and Jordan Lee/i));
    await waitFor(() => expect(onApproveSwap).toHaveBeenCalledWith(7));
  });

  it("calls onDenySwap with the swap id", async () => {
    const onDenySwap = vi.fn().mockResolvedValue(undefined);
    render(<RequestsDrawer {...BASE} onDenySwap={onDenySwap} />);
    fireEvent.click(screen.getByLabelText(/Deny swap between Alex Kim and Jordan Lee/i));
    await waitFor(() => expect(onDenySwap).toHaveBeenCalledWith(7));
  });

  it("calls onApproveTimeOff with the request id", async () => {
    const onApproveTimeOff = vi.fn().mockResolvedValue(undefined);
    render(<RequestsDrawer {...BASE} onApproveTimeOff={onApproveTimeOff} />);
    fireEvent.click(screen.getByLabelText(/Approve Sam Rivera's time off request/i));
    await waitFor(() => expect(onApproveTimeOff).toHaveBeenCalledWith(3));
  });

  it("calls onDenyTimeOff with the request id", async () => {
    const onDenyTimeOff = vi.fn().mockResolvedValue(undefined);
    render(<RequestsDrawer {...BASE} onDenyTimeOff={onDenyTimeOff} />);
    fireEvent.click(screen.getByLabelText(/Deny Sam Rivera's time off request/i));
    await waitFor(() => expect(onDenyTimeOff).toHaveBeenCalledWith(3));
  });

  it("shows the requested day and window on the availability card", () => {
    render(<RequestsDrawer {...BASE} />);
    expect(screen.getByText(/Mondays:/)).toBeInTheDocument();
    expect(screen.getByText(/12:00 PM – 10:00 PM/)).toBeInTheDocument();
    expect(screen.getByText(/Class in the morning/)).toBeInTheDocument();
  });

  it("describes 'off' and 'clear' availability requests in plain words", () => {
    const offReq   = { ...AVAILABILITY[0], id: 12, startMinutes: null, endMinutes: null, note: null };
    const clearReq = { ...AVAILABILITY[0], id: 13, employeeName: "Dana Poe", clear: true, note: null };
    render(<RequestsDrawer {...BASE} availability={[offReq, clearReq]} />);
    expect(screen.getByText(/Unavailable all day/)).toBeInTheDocument();
    expect(screen.getByText(/Any time \(remove restriction\)/)).toBeInTheDocument();
  });

  it("calls onApproveAvailability with the request id", async () => {
    const onApproveAvailability = vi.fn().mockResolvedValue(undefined);
    render(<RequestsDrawer {...BASE} onApproveAvailability={onApproveAvailability} />);
    fireEvent.click(screen.getByLabelText(/Approve Casey Fox's availability change/i));
    await waitFor(() => expect(onApproveAvailability).toHaveBeenCalledWith(11));
  });

  it("calls onDenyAvailability with the request id", async () => {
    const onDenyAvailability = vi.fn().mockResolvedValue(undefined);
    render(<RequestsDrawer {...BASE} onDenyAvailability={onDenyAvailability} />);
    fireEvent.click(screen.getByLabelText(/Deny Casey Fox's availability change/i));
    await waitFor(() => expect(onDenyAvailability).toHaveBeenCalledWith(11));
  });

  it("uses the same Approve-then-Deny button order for both request types", () => {
    render(<RequestsDrawer {...BASE} />);

    const timeOffCard = screen.getByLabelText(/Approve Sam Rivera's time off request/i).closest("div")!;
    const timeOffButtons = within(timeOffCard).getAllByRole("button");
    expect(timeOffButtons[0]).toHaveTextContent("Approve");
    expect(timeOffButtons[1]).toHaveTextContent("Deny");

    const swapCard = screen.getByLabelText(/Approve swap between Alex Kim and Jordan Lee/i).closest("div")!;
    const swapButtons = within(swapCard).getAllByRole("button");
    expect(swapButtons[0]).toHaveTextContent("Approve");
    expect(swapButtons[1]).toHaveTextContent("Deny");
  });

  it("surfaces an error when a handler rejects", async () => {
    const onApproveTimeOff = vi.fn().mockRejectedValue(new Error("Boom"));
    render(<RequestsDrawer {...BASE} onApproveTimeOff={onApproveTimeOff} />);
    fireEvent.click(screen.getByLabelText(/Approve Sam Rivera's time off request/i));
    expect(await screen.findByRole("alert")).toHaveTextContent("Boom");
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<RequestsDrawer {...BASE} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    render(<RequestsDrawer {...BASE} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
