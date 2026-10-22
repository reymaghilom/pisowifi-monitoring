import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/ui/icon";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  block?: boolean;
  loading?: boolean;
  loadingText?: string;
  icon?: IconName;
  iconSize?: number;
}

/** `pw-btn`: primary · secondary · ghost · danger · danger-outline; sm; block; loading spinner. */
export function Button({
  variant = "secondary",
  size = "md",
  block,
  loading,
  loadingText,
  icon,
  iconSize,
  className,
  children,
  type = "button",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("pw-btn", variant, size === "sm" && "sm", block && "btn-block", loading && "loading", className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <span className="pw-spin" />
          {loadingText ?? children}
        </>
      ) : (
        <>
          {icon && <Icon name={icon} size={iconSize ?? (size === "sm" ? 16 : 18)} />}
          {children}
        </>
      )}
    </button>
  );
}

/** 40px square icon button (`pw-icon-btn`). Always give it an aria-label. */
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; "aria-label": string }
>(function IconButton({ icon, className, type = "button", ...props }, ref) {
  return (
    <button ref={ref} type={type} className={cn("pw-icon-btn", className)} {...props}>
      <Icon key={icon} name={icon} />
    </button>
  );
});

/** Table row action (`pw-act`); `danger` turns the hover red. */
export function ActButton({
  icon,
  danger,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; danger?: boolean; "aria-label": string }) {
  return (
    <button type="button" className={cn("pw-act", danger && "d", className)} title={props["aria-label"]} {...props}>
      <Icon name={icon} size={18} />
    </button>
  );
}

/** Inline text button (`rowlink`). `brand` colours it teal like the prototype's "View all" links. */
export function RowLink({
  brand,
  className,
  style,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { brand?: boolean }) {
  return (
    <button
      type="button"
      className={cn("rowlink", className)}
      style={brand ? { color: "var(--brand)", ...style } : style}
      {...props}
    />
  );
}
