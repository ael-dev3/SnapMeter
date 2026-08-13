// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { InfoTip } from "./InfoTip";

describe("InfoTip", () => {
  it("keeps visual and described state synchronized for focus and Escape", async () => {
    const user = userEvent.setup();
    render(<InfoTip label="Explain the metric">Shared UTC window.</InfoTip>);
    const trigger = screen.getByRole("button", { name: "Explain the metric" });

    await user.tab();
    const tooltip = screen.getByRole("tooltip");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);

    await user.hover(trigger);
    await user.unhover(trigger);
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("toggles on click, closes outside, and permits only one open tip", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoTip label="First explanation">First tooltip.</InfoTip>
        <InfoTip label="Second explanation">Second tooltip.</InfoTip>
        <button type="button">Outside</button>
      </div>
    );
    const first = screen.getByRole("button", { name: "First explanation" });
    const second = screen.getByRole("button", { name: "Second explanation" });

    await user.click(first);
    expect(screen.getByRole("tooltip")).toHaveTextContent("First tooltip.");
    await user.click(second);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second tooltip.");
    expect(first).not.toHaveAttribute("aria-describedby");

    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("remains hoverable before dismissing after the pointer leaves", async () => {
    const user = userEvent.setup();
    render(<InfoTip label="Hover explanation">Hoverable tooltip.</InfoTip>);
    const trigger = screen.getByRole("button", { name: "Hover explanation" });

    await user.hover(trigger);
    const tooltip = screen.getByRole("tooltip");
    await user.unhover(trigger);
    await user.hover(tooltip);
    expect(tooltip).toBeInTheDocument();
    await user.unhover(tooltip);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });
});
