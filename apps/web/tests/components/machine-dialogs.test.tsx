import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MachineDialogs } from "@/components/features/machines/machine-dialogs";
import { getServices, setServicesForTesting, type Services } from "@/lib/services";
import { Toaster } from "@/components/ui/toaster";
import { useDemo } from "@/stores/demo-store";
import { router } from "../setup";

function openForm(id: string | null) {
  render(
    <>
      <MachineDialogs />
      <Toaster />
    </>,
  );
  act(() => useDemo.getState().openModal({ type: "form", id }));
}

describe("Add / Edit machine dialog", () => {
  it("has every approved field, no Tags field and no ZeroTier Member ID", async () => {
    openForm(null);
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    for (const label of ["Machine name *", "Location", "Software type", "Software version", "ZeroTier network ID", "ZeroTier managed IP *", "Admin path *", "Description"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText("Tags")).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/\btags?\b/i);
    expect(dialog).not.toHaveTextContent(/member id/i);
    await waitFor(() => expect(screen.getByLabelText("Machine name *")).toHaveFocus());
  });

  it("shows inline errors and focuses the first invalid field", async () => {
    openForm(null);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save machine" }));
    expect(screen.getByText("Machine name is required")).toBeInTheDocument();
    expect(screen.getByText("ZeroTier managed IP is required")).toBeInTheDocument();
    expect(screen.getByLabelText("Machine name *")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText("Machine name *")).toHaveFocus());

    await user.type(screen.getByLabelText("Machine name *"), "X");
    expect(screen.queryByText("Machine name is required")).not.toBeInTheDocument();
  });

  it("saves a new machine without supplying tags and shows the success dialog", async () => {
    openForm(null);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Machine name *"), "PisoWiFi 03");
    await user.type(screen.getByLabelText("ZeroTier managed IP *"), "192.168.194.90");
    await user.click(screen.getByRole("button", { name: "Save machine" }));

    expect(await screen.findByRole("heading", { name: "PisoWiFi 03 added" })).toBeInTheDocument();
    expect(screen.getByText("PisoWiFi 03 added (demo)")).toBeInTheDocument();
    const m = useDemo.getState().machines.at(-1)!;
    expect(m).toMatchObject({ name: "PisoWiFi 03", tags: [], status: null });

    await user.click(screen.getByRole("button", { name: "View machine" }));
    expect(router.push).toHaveBeenCalledWith("/machines/" + m.id);
  });

  it("edit prefills values, saves changes and keeps the machine's stored tags", async () => {
    expect(useDemo.getState().machines[0].tags).toEqual(["demo", "primary"]);
    openForm("m1");
    const user = userEvent.setup();
    expect(await screen.findByRole("dialog", { name: "Edit machine" })).toBeInTheDocument();
    const loc = screen.getByLabelText("Location");
    expect(screen.getByLabelText("Machine name *")).toHaveValue("PisoWiFi 01");
    await user.clear(loc);
    await user.type(loc, "Main store");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: "PisoWiFi 01 saved" })).toBeInTheDocument();
    expect(useDemo.getState().machines[0].loc).toBe("Main store");
    expect(useDemo.getState().machines[0].tags).toEqual(["demo", "primary"]);
    expect(screen.queryByRole("button", { name: "Add another" })).not.toBeInTheDocument();
  });

  it("Add: Software type is a dropdown with exactly one option, WiFi5Soft, selected by default and saved", async () => {
    const create = vi.fn(async (input: Parameters<Services["machines"]["create"]>[0]) => ({ ok: true as const, machine: { ...useDemo.getState().machines[0]!, ...input, id: "m9" } }));
    setServicesForTesting({ ...getServices(), machines: { ...getServices().machines, create } });
    openForm(null);
    const user = userEvent.setup();
    const sw = await screen.findByRole("combobox", { name: "Software type" });
    expect(screen.queryByRole("textbox", { name: /Software type/ })).not.toBeInTheDocument();
    expect(sw).toHaveValue("WiFi5Soft");
    const options = within(sw).getAllByRole("option");
    expect(options.map((o) => [o.textContent, (o as HTMLOptionElement).disabled])).toEqual([["WiFi5Soft", false]]);
    expect(sw).not.toHaveTextContent(/OMJI|Other/);
    await VALID(user);
    await user.click(screen.getByRole("button", { name: "Save machine" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ sw: "WiFi5Soft", tags: [] });
  });

  it("Edit: keeps WiFi5Soft selected and saves it with the stored tags", async () => {
    const update = vi.fn(async (id: string, input: Parameters<Services["machines"]["update"]>[1]) => ({ ok: true as const, machine: { ...useDemo.getState().machines[0]!, ...input, id } }));
    setServicesForTesting({ ...getServices(), machines: { ...getServices().machines, update } });
    openForm("m1");
    const user = userEvent.setup();
    const sw = await screen.findByRole("combobox", { name: "Software type" });
    expect(sw).toHaveValue("WiFi5Soft");
    expect(within(sw).getAllByRole("option")).toHaveLength(1);
    await user.type(screen.getByLabelText("Location"), " annex");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ sw: "WiFi5Soft", tags: ["demo", "primary"] });
  });

  it("Edit: an unexpected stored value is shown, not selectable, never silently replaced and never sent", async () => {
    const update = vi.fn(async (id: string, input: Parameters<Services["machines"]["update"]>[1]) => ({ ok: true as const, machine: { ...useDemo.getState().machines[0]!, ...input, id } }));
    setServicesForTesting({ ...getServices(), machines: { ...getServices().machines, update } });
    useDemo.setState((s) => ({ machines: s.machines.map((m) => (m.id === "m1" ? { ...m, sw: "Other" as const } : m)) }));
    openForm("m1");
    const user = userEvent.setup();
    const sw = await screen.findByRole("combobox", { name: "Software type" });
    expect(sw).toHaveValue("Other");
    const options = within(sw).getAllByRole("option") as HTMLOptionElement[];
    expect(options.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["WiFi5Soft"]);
    expect(options.find((o) => o.value === "Other")).toMatchObject({ disabled: true, textContent: "Other (not supported)" });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Only WiFi5Soft machines are supported")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(useDemo.getState().machines[0]!.sw).toBe("Other");
    // Only an explicit choice by the admin changes it.
    await user.selectOptions(sw, "WiFi5Soft");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ sw: "WiFi5Soft" });
  });

  it("delete asks for confirmation, Cancel keeps the machine, Delete removes it", async () => {
    render(
      <>
        <MachineDialogs />
        <Toaster />
      </>,
    );
    const user = userEvent.setup();
    act(() => useDemo.getState().openModal({ type: "delete", id: "m2" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete PisoWiFi 02?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useDemo.getState().machines).toHaveLength(2);

    act(() => useDemo.getState().openModal({ type: "delete", id: "m2" }));
    await user.click(await screen.findByRole("button", { name: "Delete machine" }));
    await waitFor(() => expect(useDemo.getState().machines.map((m) => m.id)).toEqual(["m1"]));
    expect(screen.getByText("PisoWiFi 02 deleted (demo)")).toBeInTheDocument();
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
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const VALID = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(await screen.findByLabelText("Machine name *"), "PisoWiFi 03");
  await user.type(screen.getByLabelText("ZeroTier managed IP *"), "192.168.194.90");
};

describe("Add / Edit machine dialog: accidental dismissal", () => {
  it("control: the same Escape / outside press still closes an ordinary confirmation", async () => {
    render(<MachineDialogs />);
    act(() => useDemo.getState().openModal({ type: "delete", id: "m2" }));
    await screen.findByRole("alertdialog");
    await pressOutside();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  for (const id of [null, "m1"]) {
    const title = id ? "Edit machine" : "Add machine";
    it(`${title}: Escape and clicks outside do nothing and keep the values`, async () => {
      openForm(id);
      const user = userEvent.setup();
      const loc = (await screen.findByRole("dialog", { name: title }), screen.getByLabelText("Location"));
      await user.clear(loc);
      await user.type(loc, "Annex");
      await user.keyboard("{Escape}");
      await pressOutside();
      expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Location")).toHaveValue("Annex");
      expect(useDemo.getState().modal).toMatchObject({ type: "form" });
    });

    it(`${title}: Cancel and X close at once when nothing changed`, async () => {
      const user = userEvent.setup();
      openForm(id);
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(() => expect(useDemo.getState().modal).toBeNull());

      act(() => useDemo.getState().openModal({ type: "form", id }));
      await user.click(await screen.findByRole("button", { name: "Close" }));
      await waitFor(() => expect(useDemo.getState().modal).toBeNull());
    });

    it(`${title}: unsaved changes ask first; Keep editing keeps every value, Discard changes closes`, async () => {
      openForm(id);
      const user = userEvent.setup();
      const name = await screen.findByLabelText("Machine name *");
      await user.clear(name);
      await user.type(name, "Renamed");
      await user.type(screen.getByLabelText("Description"), "draft note");

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      const ask = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
      await waitFor(() => expect(within(ask).getByRole("button", { name: "Keep editing" })).toHaveFocus());
      await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(screen.getByLabelText("Machine name *")).toHaveValue("Renamed");
      expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toContain("draft note");
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());

      // Escape or a click outside the question also means "keep editing", never closing the form underneath.
      await user.click(screen.getByRole("button", { name: "Close" }));
      await screen.findByRole("alertdialog");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "Close" }));
      await screen.findByRole("alertdialog");
      await pressOutside();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
      expect(screen.getByLabelText("Machine name *")).toHaveValue("Renamed");

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(await screen.findByRole("button", { name: "Discard changes" }));
      await waitFor(() => expect(useDemo.getState().modal).toBeNull());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      if (id) expect(useDemo.getState().machines[0].name).toBe("PisoWiFi 01");
    });
  }

  it("saving blocks a second submit and X/Cancel; a refused save keeps the form open with its values", async () => {
    const pending = deferred<Awaited<ReturnType<Services["machines"]["create"]>>>();
    const create = vi.fn(() => pending.promise);
    setServicesForTesting({ ...getServices(), machines: { ...getServices().machines, create } });
    openForm(null);
    const user = userEvent.setup();
    await VALID(user);
    await user.click(screen.getByRole("button", { name: "Save machine" }));
    const saving = screen.getByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    await user.click(saving);
    fireEvent.submit(saving.closest("form")!);
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    await act(async () => pending.resolve({ ok: false, error: { ip: "That IP is already used by another machine" } }));
    expect(await screen.findByText("That IP is already used by another machine")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add machine" })).toBeInTheDocument();
    expect(screen.getByLabelText("Machine name *")).toHaveValue("PisoWiFi 03");
    expect(screen.getByLabelText("ZeroTier managed IP *")).toHaveValue("192.168.194.90");
    expect(screen.getByRole("button", { name: "Save machine" })).toBeEnabled();
    expect(useDemo.getState().modal).toMatchObject({ type: "form" });
  });

  it("a network failure keeps the form open with its values and an error message", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Could not reach the server"));
    setServicesForTesting({ ...getServices(), machines: { ...getServices().machines, create } });
    openForm(null);
    const user = userEvent.setup();
    await VALID(user);
    await user.click(screen.getByRole("button", { name: "Save machine" }));
    expect(await screen.findByText("Could not reach the server")).toBeInTheDocument();
    expect(screen.getByLabelText("Machine name *")).toHaveValue("PisoWiFi 03");
    expect(screen.getByRole("button", { name: "Save machine" })).toBeEnabled();
    expect(useDemo.getState().modal).toMatchObject({ type: "form" });
  });

  it("Edit passes the machine's stored tags to the service unchanged (the hidden field never erases them)", async () => {
    const update = vi.fn(async (id: string, input: Parameters<Services["machines"]["update"]>[1]) => ({ ok: true as const, machine: { ...useDemo.getState().machines[0]!, ...input, id } }));
    setServicesForTesting({ ...getServices(), machines: { ...getServices().machines, update } });
    openForm("m1");
    const user = userEvent.setup();
    const loc = await screen.findByLabelText("Location");
    await user.clear(loc);
    await user.type(loc, "Annex");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ loc: "Annex", tags: ["demo", "primary"] });
  });

  it("a successful save closes the form (success dialog replaces it)", async () => {
    openForm(null);
    const user = userEvent.setup();
    await VALID(user);
    await user.click(screen.getByRole("button", { name: "Save machine" }));
    expect(await screen.findByRole("heading", { name: "PisoWiFi 03 added" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Add machine" })).not.toBeInTheDocument();
  });
});
