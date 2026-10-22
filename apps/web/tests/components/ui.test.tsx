import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConnectivityBadge, StatusBadge } from "@/components/ui/status-badge";
import { Segmented, Tabs, Toggle } from "@/components/ui/controls";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { STATUS } from "@/lib/constants";
import type { StatusKey } from "@/lib/types";

describe("StatusBadge", () => {
  it.each(Object.keys(STATUS) as StatusKey[])("%s shows a word and an icon, never colour alone", (k) => {
    const { container } = render(<StatusBadge status={k} />);
    const badge = container.querySelector(".pw-badge")!;
    expect(badge).toHaveTextContent(STATUS[k][2]);
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(badge).toHaveClass(STATUS[k][0]);
  });

  it("accepts a label override", () => {
    render(<StatusBadge status="enabled" label="Healthy" />);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });
});

describe("ConnectivityBadge", () => {
  it("two named statuses; no valid check yet is neutral text, not a status", () => {
    const { rerender } = render(<ConnectivityBadge status="reachable" />);
    expect(screen.getByText("Online").closest(".pw-badge")).toHaveClass("ok");
    rerender(<ConnectivityBadge status="unreachable" />);
    expect(screen.getByText("Offline").closest(".pw-badge")).toHaveClass("bad");
    rerender(<ConnectivityBadge status={null} />);
    expect(screen.getByText("Not checked yet")).toHaveClass("no-result");
    expect(document.querySelector(".pw-badge")).toBeNull();
  });
});

describe("controls", () => {
  it("Toggle is a switch reflecting state", async () => {
    const onChange = vi.fn();
    render(<Toggle on={false} onChange={onChange} label="Quiet hours" />);
    const sw = screen.getByRole("switch", { name: "Quiet hours" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("Tabs move with arrow keys and wrap around", async () => {
    function T() {
      const [v, setV] = useState<"a" | "b" | "c">("a");
      return (
        <Tabs
          value={v}
          onChange={setV}
          label="Sections"
          items={[
            ["a", "Rules"],
            ["b", "History"],
            ["c", "Failed"],
          ]}
        />
      );
    }
    render(<T />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Failed" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Failed" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Rules" })).toHaveAttribute("aria-selected", "true");
  });

  it("Segmented marks the active item with aria-pressed", async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        value="14"
        onChange={onChange}
        label="Range"
        items={[
          ["7", "7 d"],
          ["14", "14 d"],
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "14 d" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "7 d" }));
    expect(onChange).toHaveBeenCalledWith("7");
  });

  it("Button loading state disables it and shows the loading text", () => {
    render(
      <Button loading loadingText="Checking…" icon="refresh">
        Run check now (demo)
      </Button>,
    );
    const b = screen.getByRole("button");
    expect(b).toBeDisabled();
    expect(b).toHaveTextContent("Checking…");
    expect(b.querySelector(".pw-spin")).not.toBeNull();
  });

  it("block buttons use btn-block (not Tailwind's `block` utility)", () => {
    render(<Button block>Go</Button>);
    expect(screen.getByRole("button")).toHaveClass("pw-btn", "btn-block");
    expect(screen.getByRole("button")).not.toHaveClass("block");
  });
});

describe("cards and states", () => {
  it("KpiCard renders label, value and helper", () => {
    render(<KpiCard icon="server" label="Total machines" value={2} sub="Registered · demo" />);
    expect(screen.getByText("Total machines")).toBeInTheDocument();
    expect(screen.getByText("2")).toHaveClass("pw-kpi");
  });

  it("EmptyState and ErrorState", async () => {
    const retry = vi.fn();
    render(
      <>
        <EmptyState icon="server" title="No machines yet">
          Add your first PisoWiFi.
        </EmptyState>
        <ErrorState onRetry={retry} />
      </>,
    );
    expect(screen.getByRole("heading", { name: "No machines yet" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });
});
