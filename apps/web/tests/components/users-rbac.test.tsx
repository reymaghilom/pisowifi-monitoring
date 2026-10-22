import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminUserDto } from "@pisowifi/shared";
import type { UsersService } from "@/lib/services/types";
import { nav } from "../setup";

const REY = "00000000-0000-4000-8000-000000000001";
const CRIS = "00000000-0000-4000-8000-000000000002";
const SIB = "00000000-0000-4000-8000-000000000003";
const at = "2026-10-18T08:00:00.000Z";
const users: AdminUserDto[] = [
  { id: REY, displayName: "Rey Maghilom", email: "rey@example.test", role: "admin", status: "active", lastLoginAt: at, lockedUntil: null, deactivatedAt: null, createdAt: at },
  { id: CRIS, displayName: "Cris Basco", email: "cris@example.test", role: "admin", status: "active", lastLoginAt: at, lockedUntil: null, deactivatedAt: null, createdAt: at },
  { id: SIB, displayName: "Sibling", email: "sibling@example.test", role: "viewer", status: "active", lastLoginAt: null, lockedUntil: null, deactivatedAt: null, createdAt: at },
];

async function setup(role: "admin" | "viewer") {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "api");
  vi.stubEnv("NEXT_PUBLIC_REMOTE_MODE", "gateway");
  vi.resetModules();
  const { useDemo } = await import("@/stores/demo-store");
  const { getServices, setServicesForTesting } = await import("@/lib/services");
  const { UsersView } = await import("@/components/features/users/users-view");
  const { NavLinks } = await import("@/components/shell/nav-links");
  await useDemo.persist.rehydrate();
  useDemo.setState({ auth: true, role, uid: REY });
  nav.pathname = "/users";
  const api = {
    list: vi.fn().mockResolvedValue({ ok: true, data: users }),
    create: vi.fn(), update: vi.fn(), setRole: vi.fn(), setActive: vi.fn(), issueLink: vi.fn(), activity: vi.fn(),
  };
  setServicesForTesting({ ...getServices(), users: api as unknown as UsersService });
  return { api, UsersView, NavLinks, useDemo };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("Manage Users RBAC-2 UI", () => {
  it("hides account administration from Members while retaining monitoring and Remote Admin navigation", async () => {
    const { api, UsersView, NavLinks } = await setup("viewer");
    render(<><NavLinks /><UsersView /></>);
    expect(screen.getByText("Administrators only")).toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Manage Users" })).not.toBeInTheDocument();
    for (const name of ["Dashboard", "My PisoWiFi", "Monitoring History", "Remote Administration"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: "Reports & Analytics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Notifications & Automations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Automations / Integrations" })).not.toBeInTheDocument();
  });

  it("shows Administrator controls, account status and last sign-in, and filters the existing list", async () => {
    const { api, UsersView, NavLinks } = await setup("admin");
    render(<><NavLinks /><UsersView /></>);
    await screen.findByRole("table", { name: "Accounts" });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Manage Users" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifications & Automations" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Reports & Analytics" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Member").length).toBeGreaterThan(0);
    expect(screen.queryByText("Limited User")).not.toBeInTheDocument();
    expect(screen.getAllByText("Never").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Change role for Rey Maghilom" })).toBeDisabled();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Search accounts" }), "sibling");
    expect(screen.getByText("1 of 3 accounts", { exact: false })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "admin");
    expect(screen.getByText("No accounts match")).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("creates a Member and shows the one-time setup link only while its dialog is open", async () => {
    const { api, UsersView } = await setup("admin");
    const secret = "https://example.test/reset-password#token=private-once";
    api.create.mockResolvedValue({ ok: true, data: { user: { ...users[2], id: "00000000-0000-4000-8000-000000000004", displayName: "New sibling", email: "new@example.test" }, link: { url: secret, expiresAt: at } } });
    const log = vi.spyOn(console, "log");
    const user = userEvent.setup();
    render(<UsersView />);
    await screen.findByRole("table", { name: "Accounts" });
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.getByRole("combobox", { name: "Role" })).toHaveValue("viewer");
    const add = screen.getByRole("dialog");
    expect(within(add).getByText("Member Access")).toBeInTheDocument();
    expect(add).toHaveTextContent(
      "Members can view the dashboard, machine status, and monitoring history, and securely access Remote Administration for authorized machines. Machine management, user management, and system settings are restricted to Administrators.",
    );
    expect(add).not.toHaveTextContent(/Reports/);
    expect(within(add).getByText("Secure Account Setup")).toBeInTheDocument();
    expect(add).toHaveTextContent(
      "After creating the account, a single-use activation link valid for 60 minutes will be generated. Share this link privately with the new member so they can securely set their own password.",
    );
    await user.type(screen.getByRole("textbox", { name: "Display name" }), "New sibling");
    await user.type(screen.getByRole("textbox", { name: "Email (used to sign in)" }), "new@example.test");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(api.create).toHaveBeenCalledWith({ displayName: "New sibling", email: "new@example.test", role: "viewer" });
    expect(await screen.findByRole("textbox", { name: "One-time set-password link" })).toHaveValue(secret);
    expect(JSON.stringify({ session: sessionStorage.getItem("pw-demo"), local: { ...localStorage } })).not.toContain("private-once");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-once");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "One-time set-password link" })).not.toBeInTheDocument());
  });

  it("confirms an Administrator action and loads authorized account activity", async () => {
    const { api, UsersView } = await setup("admin");
    api.setActive.mockResolvedValue({ ok: true, data: { user: { ...users[2], status: "deactivated", deactivatedAt: at }, sessionsRevoked: 2 } });
    api.activity.mockResolvedValue({ ok: true, data: { items: [{ id: 1, action: "auth.login.succeeded", createdAt: at, actor: { id: SIB, displayName: "Sibling" }, target: { type: "user", id: SIB }, ip: null, meta: {} }], nextBefore: null } });
    const user = userEvent.setup();
    render(<UsersView />);
    await screen.findByRole("table", { name: "Accounts" });
    await user.click(screen.getAllByRole("button", { name: "Deactivate Sibling" })[0]!);
    await user.click(screen.getByRole("alertdialog").querySelector("button:last-child")!);
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith(SIB, false));
    await user.click(screen.getAllByRole("button", { name: "Activity for Sibling" })[0]!);
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    expect(api.activity).toHaveBeenCalledWith(SIB);
  });

  it("keeps edit, role change and password-link issuance as separate confirmed actions", async () => {
    const { api, UsersView } = await setup("admin");
    api.update.mockResolvedValue({ ok: true, data: { ...users[2], email: "updated@example.test" } });
    api.setRole.mockResolvedValue({ ok: true, data: { user: { ...users[2], role: "admin", email: "updated@example.test" }, sessionsRevoked: 1 } });
    const secret = "https://example.test/reset-password#token=reset-once";
    api.issueLink.mockResolvedValue({ ok: true, data: { url: secret, expiresAt: at } });
    const user = userEvent.setup();
    render(<UsersView />);
    await screen.findByRole("table", { name: "Accounts" });
    await user.click(screen.getAllByRole("button", { name: "Edit Sibling" })[0]!);
    // Editing never issues an activation link, so the new-account wording must not appear.
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/Secure Account Setup|activation link/);
    const email = screen.getByRole("textbox", { name: "Email (used to sign in)" });
    await user.clear(email);
    await user.type(email, "updated@example.test");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(SIB, { email: "updated@example.test" }));
    await user.click(screen.getAllByRole("button", { name: "Change role for Sibling" })[0]!);
    await user.click(screen.getByRole("button", { name: "Make Administrator" }));
    await waitFor(() => expect(api.setRole).toHaveBeenCalledWith(SIB, "admin"));
    await user.click(screen.getAllByRole("button", { name: "Set-password link for Sibling" })[0]!);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(api.issueLink).toHaveBeenCalledWith(SIB));
    expect(await screen.findByRole("textbox", { name: "One-time set-password link" })).toHaveValue(secret);
    expect(JSON.stringify({ session: sessionStorage.getItem("pw-demo"), local: { ...localStorage } })).not.toContain("reset-once");
  });
});

/* Radix registers its outside-pointer listener one tick after opening. */
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));
async function pressOutside() {
  await tick();
  const overlay = document.querySelector(".overlay")!;
  fireEvent.pointerDown(overlay);
  fireEvent.mouseDown(overlay);
  fireEvent.click(overlay);
  await tick();
}

describe("Add / Edit user dialogs: accidental dismissal", () => {
  async function openAdd() {
    const ctx = await setup("admin");
    const user = userEvent.setup();
    render(<ctx.UsersView />);
    await screen.findByRole("table", { name: "Accounts" });
    await user.click(screen.getByRole("button", { name: "Add user" }));
    await screen.findByRole("dialog", { name: "Add user" });
    return { ...ctx, user };
  }
  async function openEdit() {
    const ctx = await setup("admin");
    const user = userEvent.setup();
    render(<ctx.UsersView />);
    await screen.findByRole("table", { name: "Accounts" });
    await user.click(screen.getAllByRole("button", { name: "Edit Sibling" })[0]!);
    await screen.findByRole("dialog", { name: "Edit Sibling" });
    return { ...ctx, user };
  }
  const nameBox = () => screen.getByRole("textbox", { name: "Display name" });
  const emailBox = () => screen.getByRole("textbox", { name: "Email (used to sign in)" });

  it("Add user: Escape and clicks outside do nothing and keep the values", async () => {
    const { user } = await openAdd();
    await user.type(nameBox(), "New sibling");
    await user.keyboard("{Escape}");
    await pressOutside();
    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(nameBox()).toHaveValue("New sibling");
  });

  it("Edit user: Escape and clicks outside do nothing; Cancel closes at once when nothing changed", async () => {
    const { user } = await openEdit();
    await user.keyboard("{Escape}");
    await pressOutside();
    expect(screen.getByRole("dialog", { name: "Edit Sibling" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Sibling" })).not.toBeInTheDocument());
  });

  it("Add user: X closes at once when nothing changed", async () => {
    const { user } = await openAdd();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add user" })).not.toBeInTheDocument());
  });

  it("Add user: unsaved changes (including only the role) ask first; Keep editing keeps values; Discard changes closes", async () => {
    const { api, user } = await openAdd();
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "admin");
    await user.click(screen.getByRole("button", { name: "Close" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await waitFor(() => expect(within(ask).getByRole("button", { name: "Keep editing" })).toHaveFocus());
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Role" })).toHaveValue("admin");

    await user.type(nameBox(), "New sibling");
    await user.type(emailBox(), "new@example.test");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
    expect(nameBox()).toHaveValue("New sibling");
    expect(emailBox()).toHaveValue("new@example.test");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add user" })).not.toBeInTheDocument());
    expect(api.create).not.toHaveBeenCalled();
  });

  it("Edit user: a changed field asks first and Discard changes leaves the account untouched", async () => {
    const { api, user } = await openEdit();
    await user.clear(emailBox());
    await user.type(emailBox(), "changed@example.test");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(emailBox()).toHaveValue("changed@example.test");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Sibling" })).not.toBeInTheDocument());
    expect(api.update).not.toHaveBeenCalled();
  });

  it("Add user: saving blocks a second submit and X/Cancel; a refused save keeps the form open with its values", async () => {
    const { api, user } = await openAdd();
    let finish!: (v: unknown) => void;
    api.create.mockReturnValue(new Promise((r) => (finish = r)));
    await user.type(nameBox(), "New sibling");
    await user.type(emailBox(), "taken@example.test");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    const saving = screen.getByRole("button", { name: "Creating…" });
    expect(saving).toBeDisabled();
    fireEvent.submit(saving.closest("form")!);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await act(async () => finish({ ok: false, error: { status: 409, message: "Conflict", fields: { email: "An account with this email already exists" } } }));
    expect(await screen.findByText("An account with this email already exists")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add user" })).toBeInTheDocument();
    expect(nameBox()).toHaveValue("New sibling");
    expect(emailBox()).toHaveValue("taken@example.test");
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("Edit user: a network failure keeps the form open with its values and an error message", async () => {
    const { api, user } = await openEdit();
    api.update.mockRejectedValue(new TypeError("Failed to fetch"));
    await user.clear(nameBox());
    await user.type(nameBox(), "Sibling Two");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The account could not be saved. Check your connection and try again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit Sibling" })).toBeInTheDocument();
    expect(nameBox()).toHaveValue("Sibling Two");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("Edit user: a successful save closes the dialog", async () => {
    const { api, user } = await openEdit();
    api.update.mockResolvedValue({ ok: true, data: { ...users[2], displayName: "Sibling Two" } });
    await user.clear(nameBox());
    await user.type(nameBox(), "Sibling Two");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Sibling" })).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
