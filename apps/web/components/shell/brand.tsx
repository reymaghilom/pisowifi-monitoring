import { APP_NAME } from "@/lib/constants";
import { Icon } from "@/components/ui/icon";

/** Placeholder brand mark: brand-teal rounded square holding a Wi-Fi glyph. */
export function LogoMark({ inverse }: { inverse?: boolean }) {
  return (
    <span className="pw-logo-mark" style={inverse ? { background: "var(--on-hero)", color: "var(--hero)" } : undefined}>
      <Icon name="wifi" size={19} />
    </span>
  );
}

export function BrandRow({ inverse }: { inverse?: boolean }) {
  return (
    <div className="pw-row" style={{ gap: 10 }}>
      <LogoMark inverse={inverse} />
      <strong style={{ fontSize: 16 }}>{APP_NAME}</strong>
    </div>
  );
}
