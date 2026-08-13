// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("SnapMeter dashboard", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?demo=1");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("renders a clearly labelled, deterministic two-protocol demo without fetching", () => {
    render(<App />);
    expect(screen.getByText("DEMO")).toBeInTheDocument();
    expect(screen.getByText(/never a production fallback/i)).toBeInTheDocument();
    expect(screen.getByTestId("panel-snapchain")).toHaveTextContent("58,429");
    expect(screen.getByTestId("panel-hypersnap")).toHaveTextContent("55,927");
    expect(screen.getByTestId("panel-hypersnap")).toHaveTextContent("Derived");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps demo heartbeats idle until a validated live pulse exists", () => {
    render(<App />);
    expect(screen.getByTestId("heartbeat-snapchain")).toHaveAttribute("data-pulse-id", "0");
    expect(screen.getAllByText("No live pulse received in this session")).toHaveLength(2);
  });

  it("supports range selection and keyboard inspection of exact chart samples", async () => {
    const user = userEvent.setup();
    render(<App />);
    const sevenDays = screen.getByRole("button", { name: "7D" });
    await user.click(sevenDays);
    expect(sevenDays).toHaveAttribute("aria-pressed", "true");

    const chart = screen.getAllByRole("img")[0];
    expect(chart).toBeDefined();
    fireEvent.keyDown(chart!, { key: "End" });
    expect(screen.getAllByText("Snapchain").length).toBeGreaterThan(1);
    expect(screen.getByTestId("comparison-chart").querySelector(".chart-tooltip")).toHaveAttribute("data-visible");
  });
});
