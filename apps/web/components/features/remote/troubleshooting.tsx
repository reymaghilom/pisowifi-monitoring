import type { Platform } from "@/lib/domain/remote";
import { Card } from "@/components/ui/card";

type Topic = { id: string; title: string; tips: string[]; only?: Platform };

const TOPICS: Topic[] = [
  {
    id: "vpn",
    only: "android",
    title: "Android: the VPN permission didn’t appear or was denied",
    tips: [
      "Switch the network off and on again in ZeroTier One. Android asks for the VPN permission again.",
      "Settings → Network & internet → VPN: turn off any other VPN or “Always-on VPN”. Only one VPN app can be active.",
      "If you tapped Cancel, open ZeroTier One again and switch the network on, then tap OK.",
      "Battery saver can stop ZeroTier in the background. Set ZeroTier One’s battery use to Unrestricted.",
    ],
  },
  {
    id: "denied",
    title: "ZeroTier shows ACCESS DENIED (not authorized)",
    tips: [
      "Your device joined, but an administrator hasn’t approved it yet. Send them your 10-character ZeroTier address.",
      "Approval happens in ZeroTier Central → the network → Members. It is never automatic.",
      "If you reinstalled ZeroTier, the device has a new address and needs approval again.",
    ],
  },
  {
    id: "offline",
    title: "The network is disconnected, OFFLINE or has no IP address",
    tips: [
      "Check that this device has normal internet access. ZeroTier needs it to reach the network.",
      "Windows: tray icon → make sure the network is listed and checked. Restart the “ZeroTier One” service if it says OFFLINE.",
      "Android: make sure the network is switched on and the key icon shows in the status bar.",
      "Leave and rejoin the network with the correct Network ID if it never gets an IP address.",
    ],
  },
  {
    id: "noload",
    title: "The admin page doesn’t load (times out or can’t be reached)",
    tips: [
      "Use http://, not https://. The machine serves its admin page over plain HTTP on the private network.",
      "Confirm ZeroTier shows OK and an IP address in the same range as the machine (for example 192.168.194.x).",
      "Check the machine itself: if Monitoring reports it Offline, it may be switched off or disconnected.",
      "Monitoring shows Online but your device still can’t open it? The admin page answered the last check; inspect your device’s ZeroTier connection.",
      "Some workplace or school networks block ZeroTier. Try mobile data.",
    ],
  },
  {
    id: "login",
    title: "The page loads, but I can’t sign in",
    tips: [
      "Use the machine’s own admin username and password. They are separate from your PisoWiFi Monitoring account.",
      "PisoWiFi Monitoring never stores, fills in or bypasses the machine’s credentials.",
    ],
  },
];

/** Troubleshooting and Retry help. Collapsible topics; the most likely ones for the current state open first. */
export function Troubleshooting({ platform, open = [] }: { platform: Platform; open?: string[] }) {
  return (
    <Card>
      <h2 className="pw-h2" style={{ marginBottom: 4 }}>
        Troubleshooting
      </h2>
      <div className="rs-trouble">
        {TOPICS.filter((t) => !t.only || t.only === platform).map((t) => (
          <details key={t.id} open={open.includes(t.id) || undefined}>
            <summary>{t.title}</summary>
            <ul>
              {t.tips.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </Card>
  );
}
