"use client";

/* Manage Users dialogs. Confirmations are alert dialogs that open on Cancel (the safe choice). Every refusal shows
   the API's own reason (e.g. the last active Administrator). The one-time set-password link exists only in the
   LinkDialog's props while it is open: it is never written to the store, browser storage, the URL, logs or toasts. */
import { useEffect, useRef, useState } from "react";
import { ROLE_LABELS, SET_PASSWORD_LINK_TTL_MINUTES, type AdminUserDto, type AuditEntryDto, type Role } from "@pisowifi/shared";
import { manilaTime } from "@/lib/format";
import { getServices } from "@/lib/services";
import type { SetPasswordLink } from "@/lib/services/types";
import { toast } from "@/stores/toast-store";
import { Button, IconButton } from "@/components/ui/button";
import { Banner } from "@/components/ui/banner";
import { SelectField, TextField } from "@/components/ui/form";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, useDiscardGuard } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/states";

export type SetPasswordLinkView = SetPasswordLink;

const ROLE_OPTIONS: [Role, string][] = [
  ["viewer", ROLE_LABELS.viewer],
  ["admin", ROLE_LABELS.admin],
];
const ROLE_HEADING: Record<Role, string> = { viewer: "Member Access", admin: "Administrator Access" };
const ROLE_HELP: Record<Role, string> = {
  // Matches the RBAC map in @pisowifi/shared (viewer: dashboard, machines and history view, remote:open for the approved machines, own account).
  viewer:
    "Members can view the dashboard, machine status, and monitoring history, and securely access Remote Administration for authorized machines. Machine management, user management, and system settings are restricted to Administrators.",
  admin: "Everything a " + ROLE_LABELS.viewer + " can do, plus managing machines, users and settings, and viewing the audit log.",
};

/* ---------------- add / edit ---------------- */

export function UserFormDialog({
  open,
  user,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: AdminUserDto | null;
  onClose: () => void;
  onSaved: (u: AdminUserDto, link?: SetPasswordLink) => void;
}) {
  const edit = !!user;
  const [name, setName] = useState(user?.displayName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>("viewer");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // The ref blocks a second submit before React re-renders; the state drives the button and disables X/Cancel.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const dirty = name !== (user?.displayName ?? "") || email !== (user?.email ?? "") || (!edit && role !== "viewer");
  const guard = useDiscardGuard(dirty, onClose);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;
    const local: Record<string, string> = {};
    if (!name.trim()) local.displayName = "Display name is required";
    if (!email.trim()) local.email = "Enter an email address";
    setFields(local);
    setError(null);
    if (Object.keys(local).length) return;
    const users = getServices().users;
    const changes = edit ? { ...(name.trim() !== user.displayName ? { displayName: name.trim() } : {}), ...(email.trim() !== user.email ? { email: email.trim() } : {}) } : {};
    if (edit && !Object.keys(changes).length) return onClose();
    busyRef.current = true;
    setBusy(true);
    try {
      if (edit) {
        const res = await users.update(user.id, changes);
        if (!res.ok) return (setFields(res.error.fields), setError(Object.keys(res.error.fields).length ? null : res.error.message));
        toast("Saved changes to " + res.data.displayName);
        return onSaved(res.data);
      }
      const res = await users.create({ displayName: name.trim(), email: email.trim(), role });
      if (!res.ok) return (setFields(res.error.fields), setError(Object.keys(res.error.fields).length ? null : res.error.message));
      onSaved(res.data.user, res.data.link);
    } catch {
      // The form stays open with every value; only a successful save closes it.
      setError("The account could not be saved. Check your connection and try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open} dismissible={false} onClose={guard.requestClose} labelledBy="ut" as="form" onSubmit={submit} initialFocus="u-name">
        <DialogHeader>
          <DialogTitle id="ut">{edit ? "Edit " + user.displayName : "Add user"}</DialogTitle>
          <IconButton icon="x" aria-label="Close" onClick={guard.requestClose} disabled={busy} />
        </DialogHeader>
        <DialogBody>
          {error && (
            <Banner kind="bad" icon="alert">
              {error}
            </Banner>
          )}
          <TextField id="u-name" stableId label="Display name" value={name} onValue={(v) => (setName(v), setFields((f) => ({ ...f, displayName: "" })))} error={fields.displayName || undefined} autoComplete="off" maxLength={80} />
          <TextField
            id="u-email"
            stableId
            label="Email (used to sign in)"
            type="email"
            value={email}
            onValue={(v) => (setEmail(v), setFields((f) => ({ ...f, email: "" })))}
            error={fields.email || undefined}
            autoComplete="off"
            maxLength={254}
            help={edit ? "Their sign-in email. Future notifications go here too." : undefined}
          />
          {!edit && (
            <>
              <SelectField id="u-role" stableId label="Role" value={role} options={ROLE_OPTIONS} onValue={setRole} />
              <div className="pw-stack pw-small" style={{ gap: 2 }} aria-live="polite">
                <strong>{ROLE_HEADING[role]}</strong>
                <span className="pw-muted">{ROLE_HELP[role]}</span>
              </div>
              {/* Shown only when creating an account: that is when the API issues the single-use activation link. */}
              <div className="pw-stack pw-small" style={{ gap: 2 }}>
                <strong>Secure Account Setup</strong>
                <span className="pw-muted">
                  After creating the account, a single-use activation link valid for {SET_PASSWORD_LINK_TTL_MINUTES} minutes will be generated. Share this link
                  privately with the new member so they can securely set their own password.
                </span>
              </div>
            </>
          )}
          {edit && <p className="pw-small pw-muted">Role, status and passwords are changed with their own actions in the list.</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={guard.requestClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText={edit ? "Saving…" : "Creating…"}>
            {edit ? "Save changes" : "Create account"}
          </Button>
        </DialogFooter>
      </Dialog>
      {guard.confirm}
    </>
  );
}

/* ---------------- confirmations ---------------- */

function Confirm({
  title,
  children,
  error,
  confirmLabel,
  variant,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  error: string | null;
  confirmLabel: string;
  variant: "primary" | "danger";
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onClose={onClose} small alert labelledBy="ct" describedBy="cd" initialFocus="ccancel">
      <DialogHeader>
        <DialogTitle id="ct">{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {error && (
          <Banner kind="bad" icon="alert">
            {error}
          </Banner>
        )}
        <div id="cd" className="pw-stack pw-muted" style={{ gap: 8 }}>
          {children}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" id="ccancel" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={variant} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function useAction<T>(run: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>, done: (data: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    go: async () => {
      if (busy) return;
      setBusy(true);
      setError(null);
      const res = await run();
      setBusy(false);
      if (res.ok) done(res.data);
      else setError(res.error.message);
    },
  };
}

const signedOut = (n: number) => (n ? ` ${n} active ${n === 1 ? "session was" : "sessions were"} signed out.` : "");

export function RoleDialog({ user, onClose, onDone }: { user: AdminUserDto; onClose: () => void; onDone: (u: AdminUserDto) => void }) {
  const to: Role = user.role === "admin" ? "viewer" : "admin";
  const a = useAction(
    () => getServices().users.setRole(user.id, to),
    (r) => (toast(`${r.user.displayName} is now ${to === "admin" ? "an " + ROLE_LABELS.admin : "a " + ROLE_LABELS.viewer}.${signedOut(r.sessionsRevoked)}`), onDone(r.user)),
  );
  return (
    <Confirm
      title={to === "admin" ? `Make ${user.displayName} an Administrator?` : `Change ${user.displayName} to ${ROLE_LABELS.viewer}?`}
      error={a.error}
      confirmLabel={to === "admin" ? "Make Administrator" : "Change to " + ROLE_LABELS.viewer}
      variant={to === "admin" ? "primary" : "danger"}
      busy={a.busy}
      onConfirm={a.go}
      onClose={onClose}
    >
      <p>{ROLE_HELP[to]}</p>
      <p>They’re signed out everywhere and see the change when they sign in again.</p>
    </Confirm>
  );
}

export function StatusDialog({ user, onClose, onDone }: { user: AdminUserDto; onClose: () => void; onDone: (u: AdminUserDto) => void }) {
  const activate = user.status === "deactivated";
  const a = useAction(
    () => getServices().users.setActive(user.id, activate),
    (r) => (toast(activate ? `${r.user.displayName} can sign in again.` : `${r.user.displayName} is deactivated.${signedOut(r.sessionsRevoked)}`), onDone(r.user)),
  );
  return (
    <Confirm
      title={activate ? `Reactivate ${user.displayName}?` : `Deactivate ${user.displayName}?`}
      error={a.error}
      confirmLabel={activate ? "Reactivate" : "Deactivate"}
      variant={activate ? "primary" : "danger"}
      busy={a.busy}
      onConfirm={a.go}
      onClose={onClose}
    >
      {activate ? (
        <p>They can sign in again with their current password. If they don’t know it, send them a set-password link afterwards.</p>
      ) : (
        <>
          <p>They’re signed out everywhere now, can’t sign in, and any set-password link they have stops working. Their history is kept.</p>
          <p>
            A Remote Admin page they already have open may stay open for up to 30 minutes idle (4 hours at most). If they knew a WiFi5Soft password, change it on
            the device.
          </p>
        </>
      )}
    </Confirm>
  );
}

export function IssueLinkDialog({ user, onClose, onIssued }: { user: AdminUserDto; onClose: () => void; onIssued: (l: SetPasswordLink) => void }) {
  const a = useAction(() => getServices().users.issueLink(user.id), onIssued);
  return (
    <Confirm title={`New set-password link for ${user.displayName}?`} error={a.error} confirmLabel="Create link" variant="primary" busy={a.busy} onConfirm={a.go} onClose={onClose}>
      <p>They’re signed out everywhere, and any earlier link stops working. They choose a new password with this link.</p>
      <p>You see the link once, to send them privately.</p>
    </Confirm>
  );
}

/* ---------------- one-time link ---------------- */

export function LinkDialog({ user, link, created, onClose }: { user: AdminUserDto; link: SetPasswordLink; created: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState<"" | "ok" | "manual">("");
  const input = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied("ok");
    } catch {
      input.current?.select();
      setCopied("manual");
    }
  };
  return (
    <Dialog open onClose={onClose} small labelledBy="lt" describedBy="ld" initialFocus="lcopy">
      <DialogHeader>
        <DialogTitle id="lt">{created ? `${user.displayName} was added` : "Set-password link ready"}</DialogTitle>
        <IconButton icon="x" aria-label="Close" onClick={onClose} />
      </DialogHeader>
      <DialogBody>
        <p id="ld" className="pw-muted">
          Send this link to {user.displayName} privately (for example in a direct message). It works once and expires at{" "}
          <strong>{manilaTime(Date.parse(link.expiresAt))}</strong>. It is shown only now; you can create a new one later.
        </p>
        <TextField id="l-url" stableId label="One-time set-password link" value={link.url} readOnly mono ref={input} onFocus={(e) => e.currentTarget.select()} autoComplete="off" spellCheck={false} />
        <p className="pw-small" role="status" aria-live="polite">
          {copied === "ok" ? "Copied to the clipboard." : copied === "manual" ? "Couldn’t copy automatically: the link is selected, copy it with Ctrl+C or long-press." : ""}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
        <Button variant="primary" icon="link" id="lcopy" onClick={copy}>
          Copy link
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ---------------- activity ---------------- */

const ACTIONS: Record<string, string> = {
  "auth.login.succeeded": "Signed in",
  "auth.login.failed": "Sign-in failed",
  "auth.login.locked": "Sign-in blocked (locked)",
  "auth.login.deactivated": "Sign-in refused (deactivated)",
  "auth.account.locked": "Locked after failed sign-ins",
  "auth.logout": "Signed out",
  "auth.password_reset.requested": "Requested a reset link",
  "auth.password_reset.completed": "Set a new password",
  "account.password_changed": "Changed their password",
  "account.password_change_failed": "Password change failed",
  "account.profile_updated": "Updated their profile",
  "account.session_revoked": "Signed out a session",
  "account.other_sessions_revoked": "Signed out other sessions",
  "user.created": "Account created",
  "user.updated": "Details updated",
  "user.deactivated": "Deactivated",
  "user.reactivated": "Reactivated",
  "user.password_link_issued": "Set-password link created",
  "remote.ticket_issued": "Opened Remote Admin",
  "remote.ticket_refused": "Remote Admin refused",
};

function describe(e: AuditEntryDto): string {
  if (e.action === "user.role_changed") {
    const m = e.meta as { from?: Role; to?: Role };
    return m.from && m.to ? `Role changed: ${ROLE_LABELS[m.from]} → ${ROLE_LABELS[m.to]}` : "Role changed";
  }
  const label = ACTIONS[e.action] ?? e.action;
  const machine = typeof e.meta.name === "string" && e.action.startsWith("remote.") ? ` (${e.meta.name})` : "";
  return label + machine;
}

export function ActivityDialog({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const [items, setItems] = useState<AuditEntryDto[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // First page (and retries): state changes only once the request has answered.
  useEffect(() => {
    let live = true;
    void getServices()
      .users.activity(user.id)
      .then((res) => {
        if (!live) return;
        if (!res.ok) return setError(res.error.message);
        setItems(res.data.items);
        setNext(res.data.nextBefore);
      });
    return () => {
      live = false;
    };
  }, [user.id, attempt]);
  const retry = () => (setError(null), setAttempt((n) => n + 1));
  const older = async (before: number) => {
    setBusy(true);
    const res = await getServices().users.activity(user.id, before);
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setItems((cur) => [...(cur ?? []), ...res.data.items]);
    setNext(res.data.nextBefore);
  };

  return (
    <Dialog open onClose={onClose} labelledBy="at" initialFocus="aclose">
      <DialogHeader>
        <DialogTitle id="at">Activity: {user.displayName}</DialogTitle>
        <IconButton icon="x" aria-label="Close" id="aclose" onClick={onClose} />
      </DialogHeader>
      <DialogBody>
        {error && (
          <Banner kind="bad" icon="alert">
            {error}{" "}
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
          </Banner>
        )}
        {!items && !error && (
          <div className="pw-stack" aria-busy="true" aria-label="Loading activity">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} style={{ height: 40 }} />
            ))}
          </div>
        )}
        {items && !items.length && <p className="pw-muted">No activity recorded for this account yet.</p>}
        {items && items.length > 0 && (
          <ol className="pw-stack" style={{ gap: 10, listStyle: "none", padding: 0, margin: 0 }} aria-label={"Activity for " + user.displayName}>
            {items.map((e) => (
              <li key={e.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                <div style={{ fontWeight: 600 }}>{describe(e)}</div>
                <div className="pw-small pw-muted">
                  {manilaTime(Date.parse(e.createdAt))}
                  {e.actor && e.actor.id !== user.id ? ` · by ${e.actor.displayName}` : ""}
                </div>
              </li>
            ))}
          </ol>
        )}
      </DialogBody>
      <DialogFooter>
        {next !== null && (
          <Button onClick={() => void older(next)} loading={busy} loadingText="Loading…">
            Load older
          </Button>
        )}
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
