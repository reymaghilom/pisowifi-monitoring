import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/ui/icon";

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn("pw-skel", className)} style={style} />;
}

/** Page loading state: optional KPI row, then two chart cards (prototype `skeleton()`). */
export function PageSkeleton({ kpi }: { kpi?: boolean }) {
  const chartCard = (
    <div className="pw-card pw-stack" style={{ gap: 14 }}>
      <Skeleton style={{ width: "35%", height: 18 }} />
      <Skeleton style={{ height: 180 }} />
      <Skeleton style={{ width: "60%" }} />
    </div>
  );
  return (
    <div aria-busy="true" aria-label="Loading" className="pw-stack" style={{ gap: "var(--space-5)" }}>
      {kpi && (
        <div className="pw-grid pw-g4" style={{ gap: 16 }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="pw-card pw-stack" style={{ gap: 12 }}>
              <Skeleton style={{ width: "50%" }} />
              <Skeleton style={{ height: 30, width: "40%" }} />
              <Skeleton style={{ width: "70%" }} />
            </div>
          ))}
        </div>
      )}
      <div className="pw-grid pw-g2">
        {chartCard}
        {chartCard}
      </div>
    </div>
  );
}

export function EmptyState({
  tone = "",
  icon,
  title,
  children,
  actions,
}: {
  tone?: "" | "bad" | "warn" | "mute" | "ok";
  icon: IconName;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="pw-empty">
      <span className={cn("pw-empty-ic", tone)}>
        <Icon name={icon} size={26} />
      </span>
      <h2 className="pw-h2">{title}</h2>
      <p className="pw-muted" style={{ maxWidth: 380 }}>
        {children}
      </p>
      {actions}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      tone="bad"
      icon="alert"
      title="Something went wrong"
      actions={
        <button type="button" className="pw-btn secondary" onClick={onRetry}>
          <Icon name="refresh" />
          Try again
        </button>
      }
    >
      The demo could not load this page (simulated error). Nothing was lost.
    </EmptyState>
  );
}
