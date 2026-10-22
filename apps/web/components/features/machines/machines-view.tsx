"use client";

import { REMOTE_MODE } from "@/lib/constants";
import { ago } from "@/lib/format";
import { filterMachines, type MachineSort, type StatusFilter } from "@/lib/domain/machines";
import { useDemo } from "@/stores/demo-store";
import { Icon } from "@/components/ui/icon";
import { ActButton, Button, RowLink } from "@/components/ui/button";
import { SelectField } from "@/components/ui/form";
import { KeyValueList } from "@/components/ui/data-display";
import { EmptyState } from "@/components/ui/states";
import { ConnectivityBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { useCanManageMachines, useMachineNav } from "@/components/features/machines/machine-bits";

const STATUS_FILTER: [StatusFilter, string][] = [
  ["all", "All statuses"],
  ["reachable", "Online"],
  ["unreachable", "Offline"],
];
const SORTS: [MachineSort, string][] = [
  ["name", "Name A–Z"],
  ["status", "Status"],
  ["seen", "Last checked"],
  ["ip", "ZeroTier IP"],
];

export function MachinesView() {
  const nav = useMachineNav();
  const canManage = useCanManageMachines();
  return (
    <ViewGate
      actions={
        canManage ? (
          <Button variant="primary" icon="plus" onClick={nav.add}>
            Add machine
          </Button>
        ) : undefined
      }
    >
      {() => <MachinesBody />}
    </ViewGate>
  );
}

function MachinesBody() {
  const nav = useMachineNav();
  const canManage = useCanManageMachines();
  const machines = useDemo((s) => s.machines);
  const view = useDemo((s) => s.view);
  const mq = useDemo((s) => s.mq);
  const mstatus = useDemo((s) => s.mstatus);
  const msort = useDemo((s) => s.msort);
  const patch = useDemo((s) => s.patch);

  const none = !machines.length || view === "empty";
  const list = view === "empty" ? [] : filterMachines(machines, mq, mstatus, msort);
  const reset = () => patch({ mq: "", mstatus: "all" });

  let body: React.ReactNode;
  if (none)
    body = (
      <EmptyState
        icon="server"
        title="No machines yet"
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={nav.add}>
              Add machine
            </Button>
          ) : undefined
        }
      >
        {canManage ? "Add your first PisoWiFi to start tracking it." : "An admin can add machines to this workspace."}
      </EmptyState>
    );
  else if (!list.length)
    body = (
      <EmptyState tone="mute" icon="search" title="No machines match" actions={<Button onClick={reset}>Clear filters</Button>}>
        Try another search or clear the filters.
      </EmptyState>
    );
  else
    body = (
      <>
        <div className="t-lg">
          <div className="pw-tablewrap">
            <table className="pw-table">
              <caption className="sr">Registered machines</caption>
              <thead>
                <tr>
                  <th scope="col">Machine</th>
                  <th scope="col">Software</th>
                  <th scope="col">ZeroTier IP / path</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last checked</th>
                  <th scope="col">Last online</th>
                  <th scope="col">
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <RowLink onClick={() => nav.openDetail(m.id)}>{m.name}</RowLink>
                      <div className="pw-small pw-muted">{m.loc || "No location"}</div>
                    </td>
                    <td>
                      {m.sw}
                      <div className="pw-small pw-muted">{m.ver || "Version unknown"}</div>
                    </td>
                    <td>
                      <span className="pw-mono">{m.ip}</span>
                      <div className="pw-mono pw-muted">{m.path}</div>
                    </td>
                    <td>
                      <ConnectivityBadge status={m.status} />
                    </td>
                    <td className="nw">{ago(m.checkedAt)}</td>
                    <td className="nw">{ago(m.okAt)}</td>
                    <td>
                      <div className="pw-actions">
                        <ActButton icon="pulse" aria-label={"View details for " + m.name} onClick={() => nav.openDetail(m.id)} />
                        {REMOTE_MODE !== "disabled" && <ActButton icon="shield" aria-label={"Remote admin for " + m.name} onClick={() => nav.openRemote(m.id)} />}
                        {canManage && (
                          <>
                            <ActButton icon="edit" aria-label={"Edit " + m.name} onClick={() => nav.edit(m.id)} />
                            <ActButton icon="trash" danger aria-label={"Delete " + m.name} onClick={() => nav.del(m.id)} />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="c-lg cardlist">
          {list.map((m) => (
            <div key={m.id} className="pw-card pw-stack" style={{ gap: 10 }}>
              <div className="pw-row pw-between" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <RowLink className="pw-h3" onClick={() => nav.openDetail(m.id)}>
                    {m.name}
                  </RowLink>
                  <div className="pw-small pw-muted">{m.loc || "No location"}</div>
                </div>
                <ConnectivityBadge status={m.status} />
              </div>
              <KeyValueList
                rows={[
                  ["Software", m.sw + " " + (m.ver || "")],
                  ["ZeroTier IP", m.ip, true],
                  ["Admin path", m.path, true],
                  ["Last checked", ago(m.checkedAt)],
                  ["Last online", ago(m.okAt)],
                ]}
              />
              <div className="pw-row pw-wrap" style={{ gap: 8 }}>
                <Button size="sm" style={{ minHeight: 40 }} onClick={() => nav.openDetail(m.id)}>
                  Details
                </Button>
                {REMOTE_MODE !== "disabled" && (
                  <Button size="sm" style={{ minHeight: 40 }} onClick={() => nav.openRemote(m.id)}>
                    Remote admin
                  </Button>
                )}
                {canManage && (
                  <>
                    <Button size="sm" style={{ minHeight: 40 }} onClick={() => nav.edit(m.id)}>
                      Edit
                    </Button>
                    <Button variant="danger-outline" size="sm" style={{ minHeight: 40 }} onClick={() => nav.del(m.id)}>
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="pw-small pw-muted" aria-live="polite">
          {list.length} of {machines.length} machines
        </p>
      </>
    );

  return (
    <>
      <div className="pw-row pw-wrap" style={{ alignItems: "flex-end", gap: 12 }}>
        <label className="pw-search" style={{ flex: "1 1 260px", maxWidth: 420 }}>
          <Icon name="search" size={18} />
          <input id="msearch" value={mq} onChange={(e) => patch({ mq: e.target.value })} placeholder="Search by name, IP, location or tag" aria-label="Search machines" />
        </label>
        <div style={{ minWidth: 150 }}>
          <SelectField id="mstatus" label="Status" value={mstatus} options={STATUS_FILTER} onValue={(v) => patch({ mstatus: v })} />
        </div>
        <div style={{ minWidth: 150 }}>
          <SelectField id="msort" label="Sort by" value={msort} options={SORTS} onValue={(v) => patch({ msort: v })} />
        </div>
        {(mq || mstatus !== "all") && (
          <Button variant="ghost" onClick={reset}>
            Clear filters
          </Button>
        )}
      </div>
      {body}
    </>
  );
}
