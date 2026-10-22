import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm } from "@/components/features/auth/login-form";
import { Toaster } from "@/components/ui/toaster";
import { useDemo } from "@/stores/demo-store";
import { router } from "../setup";

describe("LoginForm", () => {
  it("validates empty fields, rejects a wrong password, then signs in", async () => {
    const user = userEvent.setup();
    render(
      <>
        <LoginForm />
        <Toaster />
      </>,
    );
    await user.clear(screen.getByLabelText("Email"));
    await user.clear(screen.getByLabelText("Password"));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your email")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "operator@example.com");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: /Signing in/ })).toBeDisabled();
    expect(await screen.findByText(/Invalid email or password/, {}, { timeout: 2000 })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Signed in (demo)", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(router.replace).toHaveBeenCalledWith("/dashboard");
    expect(useDemo.getState().auth).toBe(true);
  });

  it("has no two-factor step or preview", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    expect(screen.queryByText(/2FA|two-factor/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"), { timeout: 2000 });
    expect(router.push).not.toHaveBeenCalledWith("/verify");
  });

  it("password visibility toggle", async () => {
    render(<LoginForm />);
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");
  });
});
