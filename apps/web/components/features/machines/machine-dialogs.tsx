"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMachinePolicy, type MachinePolicy } from "@/lib/services/api/machines";
import type { MachineInput } from "@/lib/types";
import type { SoftwareType } from "@pisowifi/shared";
import { IP4, isSupportedSoftware, validateMachine, type MachineErrors } from "@/lib/validation";
import { machineById } from "@/lib/domain/machines";
import { getServices } from "@/lib/services";
import { useDemo } from "@/stores/demo-store";
import { toast } from "@/stores/toast-store";
import { Icon } from "@/components/ui/icon";
import { Button, IconButton } from "@/components/ui/button";
import { Banner, DemoBanner } from "@/components/ui/banner";
import { API_MODE } from "@/lib/constants";
import { SelectField, TextField, TextareaField } from "@/components/ui/form";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, useDiscardGuard } from "@/components/ui/dialog";

const BLANK: MachineInput = { name: "", loc: "", desc: "", sw: "WiFi5Soft", ver: "", ztNet: "", ip: "", path: "/admin", tags: [] };

/** All machine dialogs (add/edit form, delete confirmation, saved), driven by the store's `modal`. */
export function MachineDialogs() {
  const modal = useDemo((s) => s.modal);
  const close = () => useDemo.getState().openModal(null);
  if (!modal) return null;
  if (modal.type === "form") return <MachineFormDialog key={modal.id ?? "new"} id={modal.id} onClose={close} />;
  if (modal.type === "delete") return <DeleteMachineDialog id={modal.id} onClose={close} />;
  return <SavedDialog id={modal.id} msg={modal.msg} again={modal.again} onClose={close} />;
}

function MachineFormDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const machines = useDemo((s) => s.machines);
  const openModal = useDemo((s) => s.openModal);
  const m = id ? machineById(machines, id) : undefined;
  // Tags are no longer edited here: a machine's existing tags are sent back unchanged (new machines: none).
  const [start] = useState<MachineInput>(() =>
    m ? { name: m.name, loc: m.loc, desc: m.desc, sw: m.sw, ver: m.ver, ztNet: m.ztNet, ip: m.ip, path: m.path, tags: m.tags.slice() } : BLANK,
  );
  const [f, setF] = useState<MachineInput>(start);
  const [err, setErr] = useState<MachineErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The ref blocks a second submit before React re-renders; the state drives the button and disables X/Cancel.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const edit = !!id;
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const guard = useDiscardGuard(dirty, onClose);
  // API mode: the server's registration policy (allowed ZeroTier range, network ID), shown as field help.
  const [policy, setPolicy] = useState<MachinePolicy | null>(null);
  useEffect(() => {
    if (!API_MODE) return;
    const c = new AbortController();
    void fetchMachinePolicy(c.signal).then((p) => {
      if (!c.signal.aborted) setPolicy(p);
    });
    return () => c.abort();
  }, []);
  // WiFi5Soft is the only selectable software. A different stored value (legacy "Other") is shown as it is, disabled,
  // so it is never silently replaced; validation then asks for WiFi5Soft before anything is saved.
  const swOptions: (readonly [SoftwareType, string, boolean?])[] = [["WiFi5Soft", "WiFi5Soft"]];
  if (!isSupportedSoftware(start.sw)) swOptions.push([start.sw, start.sw + " (not supported)", true]);
  const ipHelp = policy?.allowedRanges.length ? `Must be in ${policy.allowedRanges.join(", ")} (the PisoWiFi ZeroTier network).` : undefined;
  const netHelp = API_MODE ? (policy?.networkId ? `Optional. If given, it must be ${policy.networkId}.` : "Optional.") : "Stored as text only. Not checked against ZeroTier.";

  const set = <K extends keyof MachineInput>(k: K) => (v: MachineInput[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    if (err[k as keyof MachineErrors]) setErr((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busyRef.current) return;
    setFormError(null);
    const form = f;
    const showErrors = (er: MachineErrors) => {
      const keys = (Object.keys(er) as (keyof MachineErrors)[]).filter((k) => er[k]);
      setErr(er);
      if (!keys.length) return setFormError("The machine could not be saved. Try again.");
      requestAnimationFrame(() => document.getElementById("f-" + keys[0])?.focus());
    };
    // Validate here first so errors and focus appear instantly; the service validates again.
    const er = validateMachine(form, machines, id);
    if (Object.keys(er).length) return showErrors(er);
    const clean: MachineInput = { ...form, name: form.name.trim(), loc: form.loc.trim(), desc: form.desc.trim(), ver: form.ver.trim(), ztNet: form.ztNet.trim(), ip: form.ip.trim(), path: form.path.trim() };
    const svc = getServices().machines;
    busyRef.current = true;
    setBusy(true);
    let res: Awaited<ReturnType<typeof svc.create>>;
    try {
      res = id ? await svc.update(id, clean) : await svc.create(clean);
    } catch (x) {
      // The form stays open with every value; only a successful save closes it.
      setFormError(x instanceof Error && x.message ? x.message : "The machine could not be saved. Try again.");
      return;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (!res.ok) return showErrors(res.error);
    openModal({ type: "success", id: res.machine.id, msg: clean.name + (id ? " saved" : " added"), again: !id });
    toast(clean.name + (id ? " saved" : " added") + (API_MODE ? "" : " (demo)"));
  };

  return (
    <>
      <Dialog open dismissible={false} onClose={guard.requestClose} labelledBy="dt" as="form" onSubmit={submit} initialFocus="f-name">
        <DialogHeader>
          <DialogTitle id="dt">{edit ? "Edit machine" : "Add machine"}</DialogTitle>
          <IconButton icon="x" aria-label="Close" onClick={guard.requestClose} disabled={busy} />
        </DialogHeader>
        <DialogBody>
          {formError && (
            <Banner kind="bad" icon="alert">
              {formError}
            </Banner>
          )}
          {API_MODE ? (
            <Banner kind="info" icon="info">
              <span>Saved to your workspace. Monitoring picks it up automatically; it shows “Not checked yet” until the first valid check.</span>
            </Banner>
          ) : (
            <DemoBanner title="Demo form.">Saved only in this prototype session. Nothing connects to ZeroTier or the machine.</DemoBanner>
          )}
          <div className="pw-grid pw-g2" style={{ gap: 16 }}>
            <TextField id="f-name" stableId label="Machine name *" value={f.name} onValue={set("name")} error={err.name} placeholder="e.g. PisoWiFi 03" />
            <TextField id="f-loc" stableId label="Location" value={f.loc} onValue={set("loc")} placeholder="e.g. Main store" />
            <SelectField
              id="f-sw" stableId
              label="Software type"
              value={f.sw}
              onValue={set("sw")}
              error={err.sw}
              options={swOptions}
            />
            <TextField id="f-ver" stableId label="Software version" value={f.ver} onValue={set("ver")} placeholder="e.g. v3.5.84" help="Optional" />
            <div className="span-all">
              <TextField
                id="f-ztNet" stableId
                label="ZeroTier network ID"
                mono
                value={f.ztNet}
                onValue={set("ztNet")}
                placeholder="16 hex characters"
                error={err.ztNet}
                help={netHelp}
              />
            </div>
            <TextField
              id="f-ip" stableId
              label="ZeroTier managed IP *"
              mono
              value={f.ip}
              onValue={set("ip")}
              placeholder="192.168.194.82"
              error={err.ip}
              help={ipHelp}
              ok={!!f.ip && !err.ip && IP4.test(f.ip.trim())}
            />
            <TextField id="f-path" stableId label="Admin path *" mono value={f.path} onValue={set("path")} error={err.path} help="Machine login credentials may still be required." />
          </div>
          <TextareaField id="f-desc" stableId label="Description" value={f.desc} onValue={set("desc")} placeholder="Optional notes" />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={guard.requestClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Saving…">
            {edit ? "Save changes" : "Save machine"}
          </Button>
        </DialogFooter>
      </Dialog>
      {guard.confirm}
    </>
  );
}

function DeleteMachineDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const router = useRouter();
  const m = useDemo((s) => machineById(s.machines, id));
  const confirm = async () => {
    const name = m?.name ?? "Machine";
    try {
      await getServices().machines.remove(id);
    } catch (err) {
      return toast(err instanceof Error ? err.message : "Could not delete the machine");
    }
    useDemo.getState().openModal(null);
    // Leaving a deleted machine's detail page: follow the new selection.
    if (window.location.pathname === "/machines/" + id) router.replace("/machines/" + (useDemo.getState().sel ?? "none"));
    toast(name + " deleted" + (API_MODE ? "" : " (demo)"));
  };
  return (
    <Dialog open onClose={onClose} small alert labelledBy="dt" describedBy="dd" initialFocus="dcancel">
      <DialogHeader>
        <div className="pw-row" style={{ gap: 12 }}>
          <span className="pw-ev-ic bad" style={{ width: 44, height: 44 }}>
            <Icon name="trash" size={20} />
          </span>
          <DialogTitle id="dt">Delete {m?.name ?? "machine"}?</DialogTitle>
        </div>
      </DialogHeader>
      <DialogBody>
        <p className="pw-muted" id="dd">
          This removes the machine and its demo history from the prototype. This cannot be undone.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" id="dcancel" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" icon="trash" onClick={confirm}>
          Delete machine
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function SavedDialog({ id, msg, again, onClose }: { id: string; msg: string; again: boolean; onClose: () => void }) {
  const router = useRouter();
  return (
    <Dialog open onClose={onClose} small labelledBy="dt" initialFocus="dfirst">
      <DialogBody style={{ padding: "28px 24px 8px", alignItems: "flex-start" }}>
        <span className="pw-ev-ic ok" style={{ width: 48, height: 48 }}>
          <Icon name="check" size={24} />
        </span>
        <DialogTitle id="dt">{msg}</DialogTitle>
        <p className="pw-muted">
          {API_MODE
            ? "Saved. Monitoring picks it up automatically and it shows “Not checked yet” until its first valid check."
            : "Saved in the demo list only. New machines show “Not checked yet” until their first check."}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {again && (
          <Button variant="secondary" onClick={() => useDemo.getState().openModal({ type: "form", id: null })}>
            Add another
          </Button>
        )}
        <Button
          variant="primary"
          id="dfirst"
          onClick={() => {
            useDemo.getState().selectMachine(id);
            onClose();
            router.push("/machines/" + id);
          }}
        >
          View machine
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
