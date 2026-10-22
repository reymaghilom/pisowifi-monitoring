"use client";

/* Manage Users (Administrators). The API is the authority for every rule shown here (users:manage, no self role
   change or deactivation, at least one active Administrator); this page explains the rules up front and shows the
   API's own message when it refuses. Account data and one-time links live in this component's state only: never in
   the persisted store, browser storage, the URL or a toast. */
import { useEffect, useMemo, useState } from "react";
import { ROLE_LABELS, type AdminUserDto, type Role, type UserStatus } from "@pisowifi/shared";
import { API_MODE } from "@/lib/constants";
import { ago, manilaTime } from "@/lib/format";
import { useCan } from "@/lib/permissions";
import { getServices } from "@/lib/services";
import { DEMO_SELF_ID } from "@/lib/services/mock/users";
import { useDemo } from "@/stores/demo-store";
import { Icon } from "@/components/ui/icon";
import { ActButton, Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/form";
import { KeyValueList } from "@/components/ui/data-display";
import { EmptyState, PageSkeleton, Skeleton } from "@/components/ui/states";
import { Banner } from "@/components/ui/banner";
import { useHydrated } from "@/hooks/use-hydrated";
import { PageHead } from "@/components/demo/page-head";
import { ActivityDialog, LinkDialog, RoleDialog, StatusDialog, UserFormDialog, IssueLinkDialog, type SetPasswordLinkView } from "@/components/features/users/user-dialogs";

type RoleFilter = "all" | Role;
type StatusFilter = "all" | UserStatus;
const ROLE_FILTER: [RoleFilter, string][] = [["all", "All roles"], ["admin", ROLE_LABELS.admin], ["viewer", ROLE_LABELS.viewer]];
const STATUS_FILTER: [StatusFilter, string][] = [["all", "All statuses"], ["active", "Active"], ["deactivated", "Deactivated"], ["locked", "Locked"]];
const STATUS_BADGE: Record<UserStatus, [string, string, Parameters<typeof Icon>[0]["name"]]> = {
  active: ["ok", "Active", "check"],
  deactivated: ["mute", "Deactivated", "lock"],
  locked: ["warn", "Locked", "clock"],
};

export type Modal =
  | { type: "add" }
  | { type: "edit"; user: AdminUserDto }
  | { type: "role"; user: AdminUserDto }
  | { type: "status"; user: AdminUserDto }
  | { type: "issue-link"; user: AdminUserDto }
  | { type: "link"; user: AdminUserDto; link: SetPasswordLinkView; created: boolean }
  | { type: "activity"; user: AdminUserDto }
  | null;

export function UsersView() {
  const allowed = useCan("users:manage");
  if (!allowed)
    return (
      <>
        <PageHead />
        <EmptyState tone="mute" icon="lock" title="Administrators only">
          Managing accounts is limited to Administrators. Ask an Administrator if you need a change to your access.
        </EmptyState>
      </>
    );
  return <UsersGate />;
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={"pw-badge " + (role === "admin" ? "info" : "mute")}>
      <Icon name={role === "admin" ? "shield" : "user"} size={14} />
      {ROLE_LABELS[role]}
    </span>
  );
}

function StatusChip({ status }: { status: UserStatus }) {
  const [tone, word, icon] = STATUS_BADGE[status];
  return (
    <span className={"pw-badge " + tone}>
      <Icon name={icon} size={14} />
      {word}
    </span>
  );
}

function lastSignIn(u: AdminUserDto) {
  return u.lastLoginAt ? <span title={manilaTime(Date.parse(u.lastLoginAt))}>{ago(Date.parse(u.lastLoginAt))}</span> : <span className="pw-muted">Never</span>;
}

/** Same first-render behaviour as ViewGate (no flash before the persisted session is read), with this page's header. */
function UsersGate() {
  const hydrated = useHydrated();
  if (!hydrated)
    return (
      <>
        <PageHead />
        <PageSkeleton />
      </>
    );
  return <UsersBody />;
}

function UsersBody() {
  const me = useDemo((s) => s.uid) ?? (API_MODE ? null : DEMO_SELF_ID);
  const [users, setUsers] = useState<AdminUserDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [modal, setModal] = useState<Modal>(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void getServices()
      .users.list()
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setUsers(res.data);
          setError(null);
        } else setError(res.error.message);
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  const load = () => (setError(null), setAttempt((n) => n + 1));

  /** After a change: put the returned account in place (the list stays in sync without a refetch). */
  const replace = (u: AdminUserDto) => setUsers((list) => (list ?? []).map((x) => (x.id === u.id ? u : x)));
  const activeAdmins = (users ?? []).filter((u) => u.role === "admin" && u.status !== "deactivated").length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (users ?? []).filter(
      (u) => (!needle || u.displayName.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle)) && (role === "all" || u.role === role) && (status === "all" || u.status === status),
    );
  }, [users, q, role, status]);

  const head = (
    <PageHead
      actions={
        <Button variant="primary" icon="plus" onClick={() => setModal({ type: "add" })}>
          Add user
        </Button>
      }
    />
  );

  let body: React.ReactNode;
  if (error && !users)
    body = (
      <EmptyState tone="bad" icon="alert" title="Couldn’t load accounts" actions={<Button icon="refresh" onClick={load}>Try again</Button>}>
        {error}
      </EmptyState>
    );
  else if (!users)
    body = (
      <div className="pw-stack" aria-busy="true" aria-label="Loading accounts">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} style={{ height: 56 }} />
        ))}
      </div>
    );
  else if (!users.length)
    body = (
      <EmptyState icon="users" title="No accounts yet" actions={<Button variant="primary" icon="plus" onClick={() => setModal({ type: "add" })}>Add user</Button>}>
        Add the people who should see this workspace. They set their own password through a one-time link.
      </EmptyState>
    );
  else if (!shown.length)
    body = (
      <EmptyState tone="mute" icon="search" title="No accounts match" actions={<Button onClick={() => (setQ(""), setRole("all"), setStatus("all"))}>Clear filters</Button>}>
        Try another search or clear the filters.
      </EmptyState>
    );
  else
    body = (
      <>
        <div className="t-lg">
          <div className="pw-tablewrap">
            <table className="pw-table">
              <caption className="sr">Accounts</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <UserName u={u} self={u.id === me} />
                      <Restriction u={u} self={u.id === me} activeAdmins={activeAdmins} />
                    </td>
                    <td>
                      <RoleBadge role={u.role} />
                    </td>
                    <td>
                      <StatusChip status={u.status} />
                    </td>
                    <td className="nw">{lastSignIn(u)}</td>
                    <td>
                      <RowActions u={u} self={u.id === me} activeAdmins={activeAdmins} open={setModal} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="c-lg cardlist">
          {shown.map((u) => (
            <article key={u.id} className="pw-card pw-stack" style={{ gap: 10 }} aria-label={u.displayName}>
              <div className="pw-row pw-between" style={{ alignItems: "flex-start", gap: 8 }}>
                <UserName u={u} self={u.id === me} />
                <StatusChip status={u.status} />
              </div>
              <KeyValueList rows={[["Role", <RoleBadge key="r" role={u.role} />], ["Last sign-in", lastSignIn(u)]]} />
              <Restriction u={u} self={u.id === me} activeAdmins={activeAdmins} />
              <CardActions u={u} self={u.id === me} activeAdmins={activeAdmins} open={setModal} />
            </article>
          ))}
        </div>
        <p className="pw-small pw-muted" aria-live="polite">
          {shown.length} of {users.length} accounts · {activeAdmins} active {activeAdmins === 1 ? "Administrator" : "Administrators"}
        </p>
      </>
    );

  return (
    <>
      {head}
      <div className="pw-stack" style={{ gap: 16 }}>
        {error && users && (
          <Banner kind="bad" icon="alert">{error}</Banner>
        )}
        <div className="pw-row pw-wrap" style={{ alignItems: "flex-end", gap: 12 }}>
          <label className="pw-search" style={{ flex: "1 1 260px", maxWidth: 420 }}>
            <Icon name="search" size={18} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" aria-label="Search accounts" />
          </label>
          <div style={{ minWidth: 150 }}>
            <SelectField id="urole" label="Role" value={role} options={ROLE_FILTER} onValue={setRole} />
          </div>
          <div style={{ minWidth: 150 }}>
            <SelectField id="ustatus" label="Status" value={status} options={STATUS_FILTER} onValue={setStatus} />
          </div>
        </div>
        {body}
      </div>

      <UserFormDialog
        key={modal?.type === "edit" ? "edit-" + modal.user.id : modal?.type === "add" ? "add" : "closed"}
        open={modal?.type === "add" || modal?.type === "edit"}
        user={modal?.type === "edit" ? modal.user : null}
        onClose={() => setModal(null)}
        onSaved={(u, link) => {
          if (link) {
            setUsers((list) => [...(list ?? []), u]);
            setModal({ type: "link", user: u, link, created: true });
          } else {
            replace(u);
            setModal(null);
          }
        }}
      />
      {modal?.type === "role" && <RoleDialog user={modal.user} onClose={() => setModal(null)} onDone={(u) => (replace(u), setModal(null))} />}
      {modal?.type === "status" && <StatusDialog user={modal.user} onClose={() => setModal(null)} onDone={(u) => (replace(u), setModal(null))} />}
      {modal?.type === "issue-link" && <IssueLinkDialog user={modal.user} onClose={() => setModal(null)} onIssued={(link) => setModal({ type: "link", user: modal.user, link, created: false })} />}
      {modal?.type === "link" && <LinkDialog user={modal.user} link={modal.link} created={modal.created} onClose={() => setModal(null)} />}
      {modal?.type === "activity" && <ActivityDialog user={modal.user} onClose={() => setModal(null)} />}
    </>
  );
}

function UserName({ u, self }: { u: AdminUserDto; self: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="pw-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong style={{ overflowWrap: "anywhere" }}>{u.displayName}</strong>
        {self && <span className="pw-chip">You</span>}
      </div>
      <div className="pw-small pw-muted" style={{ overflowWrap: "anywhere" }}>
        {u.email}
      </div>
    </div>
  );
}

/** Why some actions are unavailable, in words (disabled buttons can’t be focused, so the reason is shown here). */
function Restriction({ u, self, activeAdmins }: { u: AdminUserDto; self: boolean; activeAdmins: number }) {
  const lastAdmin = !self && u.role === "admin" && u.status !== "deactivated" && activeAdmins <= 1;
  if (self) return <p className="pw-small pw-muted">Your own account: change your password in Settings → Security. Another Administrator can change your role.</p>;
  if (lastAdmin) return <p className="pw-small pw-muted">The only active Administrator: make someone else an Administrator before changing this role or deactivating.</p>;
  return null;
}

type ActionProps = { u: AdminUserDto; self: boolean; activeAdmins: number; open: (m: Modal) => void };

function useActions({ u, self, activeAdmins }: Omit<ActionProps, "open">) {
  const lastAdmin = u.role === "admin" && u.status !== "deactivated" && activeAdmins <= 1;
  const deactivated = u.status === "deactivated";
  return {
    roleDisabled: self || lastAdmin,
    statusDisabled: deactivated ? false : self || lastAdmin,
    linkDisabled: self || deactivated,
    deactivated,
  };
}

function RowActions({ u, self, activeAdmins, open }: ActionProps) {
  const a = useActions({ u, self, activeAdmins });
  const name = u.displayName;
  return (
    <div className="pw-actions">
      <ActButton icon="history" aria-label={"Activity for " + name} onClick={() => open({ type: "activity", user: u })} />
      <ActButton icon="edit" aria-label={"Edit " + name} onClick={() => open({ type: "edit", user: u })} />
      <ActButton icon="shield" aria-label={"Change role for " + name} disabled={a.roleDisabled} onClick={() => open({ type: "role", user: u })} />
      <ActButton icon="key" aria-label={"Set-password link for " + name} disabled={a.linkDisabled} onClick={() => open({ type: "issue-link", user: u })} />
      <ActButton
        icon={a.deactivated ? "play" : "pause"}
        danger={!a.deactivated}
        aria-label={(a.deactivated ? "Reactivate " : "Deactivate ") + name}
        disabled={a.statusDisabled}
        onClick={() => open({ type: "status", user: u })}
      />
    </div>
  );
}

function CardActions({ u, self, activeAdmins, open }: ActionProps) {
  const a = useActions({ u, self, activeAdmins });
  const name = u.displayName;
  const btn = { size: "sm" as const, style: { minHeight: 44 } };
  return (
    <div className="pw-row pw-wrap" style={{ gap: 8 }}>
      <Button {...btn} aria-label={"Activity for " + name} onClick={() => open({ type: "activity", user: u })}>
        Activity
      </Button>
      <Button {...btn} aria-label={"Edit " + name} onClick={() => open({ type: "edit", user: u })}>
        Edit
      </Button>
      {!a.roleDisabled && (
        <Button {...btn} aria-label={"Change role for " + name} onClick={() => open({ type: "role", user: u })}>
          Change role
        </Button>
      )}
      {!a.linkDisabled && (
        <Button {...btn} aria-label={"Set-password link for " + name} onClick={() => open({ type: "issue-link", user: u })}>
          Password link
        </Button>
      )}
      {!a.statusDisabled && (
        <Button {...btn} variant={a.deactivated ? "secondary" : "danger-outline"} aria-label={(a.deactivated ? "Reactivate " : "Deactivate ") + name} onClick={() => open({ type: "status", user: u })}>
          {a.deactivated ? "Reactivate" : "Deactivate"}
        </Button>
      )}
    </div>
  );
}
