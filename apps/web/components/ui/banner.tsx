import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icon";

export function Banner({
  kind,
  icon,
  children,
}: {
  kind: "info" | "warn" | "bad" | "ok";
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <div className={"pw-banner " + kind} role={kind === "bad" ? "alert" : "note"}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

/** Honesty rule: every screen with invented numbers says so. */
export function DemoBanner({
  title = "Demo data.",
  children = "Numbers, events and charts here are samples for the design prototype. Nothing is measured from real machines.",
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <Banner kind="info" icon="info">
      <strong>{title}</strong> {children}
    </Banner>
  );
}
