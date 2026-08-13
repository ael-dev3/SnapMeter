// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDemoSummary } from "../data/demo";
import { ProtocolPanel } from "./ProtocolPanel";

describe("ProtocolPanel action heartbeat", () => {
  it("uses the latest live pulse action time instead of a separate snapshot clock", () => {
    const metrics = createDemoSummary().sources.snapchain;
    metrics.lastActionAtMs = 2_000;

    render(
      <ProtocolPanel
        source="snapchain"
        metrics={metrics}
        transport="live"
        pulse={{ id: 1, count: 3, lastActionAtMs: 10_000 }}
        now={17_000}
        demo={false}
      />
    );

    const heartbeat = screen.getByTestId("heartbeat-snapchain");
    expect(heartbeat).toHaveAttribute("data-pulse-id", "1");
    expect(within(heartbeat).getByText("3 qualifying actions · last action 7s ago")).toBeInTheDocument();
    expect(screen.queryByText("15s ago")).not.toBeInTheDocument();
    expect(screen.queryByText("Last action · heartbeat")).not.toBeInTheDocument();
  });
});
