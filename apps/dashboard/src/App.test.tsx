// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { Analytics } from "./components/Analytics";
import { createDemoSummary } from "./data/demo";

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
    expect(within(screen.getByTestId("panel-snapchain")).getByLabelText("SnapMeter Snapchain")).toHaveTextContent("SNAPMETER");
    expect(within(screen.getByTestId("panel-hypersnap")).getByLabelText("SnapMeter Hypersnap")).toHaveTextContent("SNAPMETER");
    expect(within(screen.getByTestId("panel-snapchain")).getByText("Rolling 24h DAU")).toBeVisible();
    expect(within(screen.getByTestId("panel-hypersnap")).getByText("Observed rolling 24h DAU")).toBeVisible();
    expect(screen.getAllByText(/unique active fids · shared utc window/i)).toHaveLength(2);
    expect(screen.getByText(/shared rolling 24h · both sources · ending/i)).toBeInTheDocument();
    expect(screen.getByText(/shared dau timeframe · both sources/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps demo heartbeats idle until a validated live pulse exists", () => {
    render(<App />);
    expect(screen.getByTestId("heartbeat-snapchain")).toHaveAttribute("data-pulse-id", "0");
    expect(screen.getAllByText(/Last recorded action .* awaiting a live pulse/)).toHaveLength(2);
    expect(screen.queryByText(/Last action · heartbeat/i)).not.toBeInTheDocument();
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

  it("withholds action-mix comparison when source windows differ", () => {
    const summary = createDemoSummary();
    summary.sources.hypersnap.updatedAtMs += 1;
    render(<Analytics summary={summary} now={summary.generatedAtMs} />);
    expect(screen.getByText(/source windows end at different times/i)).toBeVisible();
    expect(screen.queryByRole("group", { name: /qualifying action mix.*shared rolling 24 hour/i })).not.toBeInTheDocument();
  });
});
