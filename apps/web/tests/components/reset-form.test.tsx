import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResetForm } from "@/components/features/auth/reset-form";

describe("ResetForm", () => {
  it("reads the token from the link fragment, hides it from the address bar, validates, then confirms", async () => {
    window.history.replaceState(null, "", "/reset-password#token=" + "t".repeat(43));
    const user = userEvent.setup();
    render(<ResetForm />);
    expect(window.location.hash).toBe("");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(screen.getAllByText("Use at least 12 characters").length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText("New password"), "a brand new passphrase");
    await user.type(screen.getByLabelText("Confirm password"), "something else entirely");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("Confirm password"), "a brand new passphrase");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByRole("heading", { name: "Password updated" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("explains an incomplete link and offers a new one", () => {
    window.history.replaceState(null, "", "/reset-password");
    render(<ResetForm />);
    expect(screen.getByText(/This reset link is incomplete/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set new password" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
  });
});
