PisoWiFi Monitoring is a monitoring and remote-management web app for WiFi5Soft PisoWiFi machines. This system is the **design language and screen blueprint** for it: tokens, component styles, and one live preview per screen. It is a design prototype — no backend, no real API.

## Content fundamentals
- Voice: calm, plain, operational. Say what happened and what to do. "PisoWiFi 02 is unreachable. The last HTTP check failed 4 min ago."
- Sentence case everywhere. Buttons are verbs: "Add machine", "Open Remote Admin", "Save changes". Use "you", never "we" for the app.
- Name machines exactly as registered ("PisoWiFi 01"). Show IPs and paths in `mono`: `192.168.194.82/admin`.
- No emoji. No exclamation marks. No "Oops".

## Honesty rules (non-negotiable)
- Every screen with invented numbers shows a `demo` or `sample` badge, or a banner saying so. Never present mock data as live monitoring.
- Planned features use `soon` ("Coming Soon") and `notconn` ("Not Connected Yet"). Their metric cards show "—", never a number: sales, revenue, CPU, CPU temperature, RAM, storage, connected users, n8n, Telegram.
- Remote Administration carries a permanent "Prototype only — not operational yet" banner and the sentence "Original WiFi5Soft login will still be required." Its login area is a labelled placeholder with skeleton bars; never draw a working WiFi5Soft form.
- Never say ZeroTier "last seen" proves internet access. Keep four separate blocks on Machine Details: ZeroTier status, Admin interface, Internet verification, Monitoring state. Internet defaults to `inet` ("Internet Not Yet Verified").
- Do not show secrets, tokens or real credentials; disabled inputs say "Not configured".

## Visual foundations
- Colour: Emerald Teal + Charcoal identity. Teal `brand` is the only decorative hue (light `#0f766e` for fills and text, identity teal `#0d9488` for focus rings and charts; dark `#2dd4bf` on charcoal `#111c1b` / `#1c2b29`). Teal is kept clearly apart from `success` green (hue ~175° vs ~105°), and every status still carries an icon and a word. Status colours mean state only: `success` Reachable, `danger` Unreachable/Error, `warning` Stale/needs verification, `neutral` Unknown/Coming Soon. Every state is a word + icon + colour (use `StatusBadge`), so red/green is never the only signal. Pair soft fills with their matching ink: `success` on `success-soft`, and so on.
- Surfaces: page is `bg`; cards, sidebar, header, dialogs are `surface` with a `border` hairline and `shadow-sm`. Dialogs and drawers use `shadow-md`. Fills inside cards use `surface-2`.
- Text: headings `ink`, secondary `ink-muted` (both pass 4.5:1 on `bg`, `surface`, `surface-2` in light and dark). Inputs use `border-strong` (3:1).
- Type: Inter. Page title `h1`, card title `h2`, machine name `h3`, body `body`, helper and timestamps `small`, table headers `label`, big numbers `kpi`, login hero `display`. IPs, paths, IDs use `mono`.
- Radius: buttons, inputs, nav `radius-md`; cards, tables, banners `radius-lg`; dialogs `radius-xl`; badges and toggles `radius-pill`.
- Spacing: 4 · 8 · 12 · 16 · 24 · 32 · 48 (`space-1`–`space-7`). Card padding `space-5`; page padding `space-6` on desktop, `space-4` on mobile.
- Focus: 2px solid `focus` ring with 2px offset on every interactive element. Touch targets are at least 40px.
- Charts: `chart-1` for PisoWiFi 01 (solid), `chart-2` for PisoWiFi 02 (dashed), `chart-grid` for gridlines. Always put a `sample` badge on the card and a legend below. Prefer a status strip for up/down timelines.
- Themes: ship `light` and `dark`; the theme toggle only swaps `data-theme`. Components use tokens only, never literal colours.

## Layout and responsive rules
- Desktop (≥ 900px): 248px sidebar, sticky header (page title, search, refresh, theme toggle, profile menu), content max 1280px, 12-col feel with `pw-g2/g3/g4` grids.
- Below 900px: sidebar becomes a left drawer opened from a menu button; header collapses to menu · title · refresh; grids become one column; tables become `pw-mcard` cards; no horizontal scroll. See `MobileLayouts`.
- Navigation order: Dashboard, My PisoWiFi, Machine Details, Remote Administration, Monitoring History, Reports & Analytics, Automations / Integrations, Settings.

## Screens (one preview each, under Screens)
| Screen | Preview | Key rules |
| --- | --- | --- |
| Login, Forgot password, 2FA | `LoginScreens` | Split hero on desktop, focused form on mobile; show/hide password; error and loading states; 2FA is UI only. |
| Dashboard | `Dashboard` | 4 summary cards, overview chart (sample), quick machine cards, recent events, quick actions. |
| My PisoWiFi | `MachinesPage` | Table on desktop, cards on mobile; search, status filter, sort; Add/Edit form with validation; delete dialog; success state. |
| Machine Details | `MachineDetail` | Overview plus four separate status blocks, mini history, events, actions. |
| Remote Administration | `RemoteAdmin` | Machine picker, connection stepper, placeholder panel, session info, troubleshooting; states: preparing, ready, unavailable, retry, unauthorized. |
| Monitoring History | `History` | Filters, timeline strip, uptime chart, downtime summary, event log, recent outages. |
| Reports & Analytics | `Reports` | Reliability comparison, trends, weekly and monthly summaries; future metrics as Coming Soon. |
| Automations / Integrations | `Automations` | n8n and Telegram not connected; rules list with toggles; execution history; failures. |
| Settings | `Settings` | Profile, Security, Sessions, Theme, Monitoring, ZeroTier, Notifications, Automation. |
| UX states | `UxStates` | Skeleton, loading, empty, error, unauthorized, unreachable, stale, success, delete confirmation. |

## Using the bundle
`window.PisoWiFi` provides HTML-string helpers (not React components): `AppShell(active, title, subtitle, contentHTML, actionsHTML)`, `StatusBadge(key, label?)`, `LineChart({...})`, plus `bars`, `strip`, `kpi`, `field`, `icon(name)` and `data` (sample machines and series). Style with the `pw-*` classes in `bundle.css`. Status keys: reachable, unreachable, recent, stale, unknown, error, inet, soon, notconn, demo, sample, proto, enabled, paused, failed, nodata.

## Iconography
Inline 24px stroke icons (1.8px, round caps) drawn in the bundle's `icon()` helper, coloured with `currentColor`. No icon font and no emoji. These are generic hand-drawn glyphs, not a licensed icon set.

## Brand mark
The mark is a brand-teal rounded square holding a Wi-Fi glyph, next to the wordmark "PisoWiFi Monitoring" in Inter 700. No logo file was provided; this is a placeholder mark to replace when one exists.
