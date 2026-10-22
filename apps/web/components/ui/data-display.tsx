"use client";

import type { ReactNode } from "react";
import { EVICON } from "@/lib/constants";
import { ago } from "@/lib/format";
import type { Machine, MonitoringEvent } from "@/lib/types";
import { machineName } from "@/lib/domain/machines";
import { Icon } from "@/components/ui/icon";

/** Definition list (`pw-kv`). Pass `[term, value, mono?]` rows. `wide` uses the 4-column kv2 layout. */
export function KeyValueList({ rows, wide, style }: { rows: [ReactNode, ReactNode, boolean?][]; wide?: boolean; style?: React.CSSProperties }) {
  return (
    <dl className={"pw-kv" + (wide ? " kv2" : "")} style={wide ? style : { margin: 0, ...style }}>
      {rows.map(([dt, dd, mono], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{dt}</dt>
          <dd className={mono ? "pw-mono" : undefined}>{dd}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Event feed (`pw-events`): icon by type, machine name, message, relative time. */
export function EventList({ events, machines, n = 5 }: { events: MonitoringEvent[]; machines: Machine[]; n?: number }) {
  if (!events.length) return <p className="pw-muted">No events yet.</p>;
  return (
    <ul className="pw-events">
      {events.slice(0, n).map((e, i) => {
        const [tone, icon] = EVICON[e.type] ?? EVICON.check;
        return (
          <li key={e.t + e.m + i}>
            <span className={"pw-ev-ic " + tone}>
              <Icon name={icon} size={16} />
            </span>
            <div className="pw-grow">
              <div style={{ fontWeight: 600 }}>{machineName(machines, e.m)}</div>
              <div className="pw-muted" style={{ fontSize: 13 }}>
                {e.msg}
              </div>
            </div>
            <span className="pw-small pw-muted" style={{ whiteSpace: "nowrap" }}>
              {ago(e.t)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
