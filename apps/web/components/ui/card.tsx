import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/ui/icon";
import type { Tone } from "@/lib/constants";

export function Card({ flat, stack, className, ...props }: HTMLAttributes<HTMLDivElement> & { flat?: boolean; stack?: boolean }) {
  return <div className={cn("pw-card", flat && "flat", stack && "pw-stack", className)} {...props} />;
}

/** Card heading row: title (+ optional subtitle) on the left, actions/badges on the right. */
export function CardHead({
  title,
  sub,
  children,
  className,
  style,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={cn("pw-card-head", className)} style={style}>
      {sub ? (
        <div>
          <h2 className="pw-h2">{title}</h2>
          <div className="pw-small pw-muted">{sub}</div>
        </div>
      ) : (
        <h2 className="pw-h2">{title}</h2>
      )}
      {children}
    </div>
  );
}

/** Tinted icon tile used in KPI cards and status blocks (`pw-stat-ic`). */
export function StatIcon({ icon, tone, size = 19, style }: { icon: IconName; tone?: Tone | ""; size?: number; style?: React.CSSProperties }) {
  return (
    <span className={cn("pw-stat-ic", tone)} style={style}>
      <Icon name={icon} size={size} />
    </span>
  );
}

/** Summary card: label, icon, big number, helper line (`P.kpi`). */
export function KpiCard({ icon, tone, label, value, sub }: { icon: IconName; tone?: Tone | ""; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="pw-card pw-stat">
      <div className="pw-stat-top">
        <span className="pw-label">{label}</span>
        <StatIcon icon={icon} tone={tone} />
      </div>
      <div className="pw-kpi">{value}</div>
      <div className="pw-small pw-muted">{sub}</div>
    </div>
  );
}
