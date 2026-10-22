# PisoWiFi Monitoring — web frontend

Next.js 16 (App Router, Cache Components) + TypeScript + Tailwind CSS v4 + Radix primitives (via shadcn/ui).
Implements the approved Emerald Teal + Charcoal prototype in
`../../design-reference/pisowifi-monitoring-design-system/reference/pisowifi-monitoring-prototype.html` without redesign.

There is **no backend yet**. All data is sample data from `lib/mock/` held in a session store (`stores/demo-store.ts`).

## Run

```bash
npm install
cp .env.example .env.local   # NEXT_PUBLIC_DEMO_MODE=true shows the demo preview controls
npm run dev                  # http://localhost:3000 — sign in with any email and the password "demo"
```

`npm run lint`, `npm run typecheck`, `npm test` and `npm run build` should all pass. `npm run test:e2e` and
`npm run test:visual` run Playwright against a production build (see the root README).

## Layout

| Path | What |
| --- | --- |
| `app/globals.css` | Design tokens (1:1 from `tokens.css`, light/dark) mapped to Tailwind utilities |
| `styles/pw.css` | The prototype's component CSS (`pw-*`), ported verbatim into the components layer |
| `app/(auth)/…` | Login (email + password), forgot password, reset password (`/reset-password#token=…`) |
| `app/(app)/…` | Dashboard, My PisoWiFi, Machine Details (`/machines/[id]`), Remote Administration, Monitoring History, Reports & Analytics, Automations / Integrations, Settings (`/settings/[section]`) |
| `components/ui` | Token-styled primitives: Button, StatusBadge, Banner, Card/KpiCard, form fields, Toggle/Segmented/Tabs, Dialog, states, Icon |
| `components/charts` | SVG LineChart / BarChart / StatusStrip ported from the prototype, legend toggles, shared tooltip |
| `components/shell` | Sidebar (collapsible), header, profile menu, mobile drawer, theme sync |
| `components/features/*` | One folder per screen |
| `lib/mock/history.ts` | Seeded sample history engine |
| `lib/domain/*` | Pure business rules: machine filters/KPIs, history windows and CSV, report aggregations, remote access setup steps and admin links |
| `lib/services/*` | Service interfaces (`types.ts`), mock implementation (`mock/`), single entry point `getServices()` |
| `tests/` | Vitest unit, service-contract and component tests |
| `e2e/` | Playwright flows (`flows.spec.ts`) and visual comparison with the prototype (`visual.spec.ts`) |

## Notes

- Demo-only controls ("Preview state", "Simulate state (demo)") render only when `NEXT_PUBLIC_DEMO_MODE=true`.
- The Add/Edit machine form has no ZeroTier Member ID field by design.
- Honesty rules from the design system apply: invented numbers carry a demo/sample badge; future metrics show "—".

## Real sign-in (API data source, B3)

`NEXT_PUBLIC_DATA_SOURCE=api` uses `lib/services/api/`: sign-in, the session check, sign-out, account
management (Settings → Profile, Security, Sessions; forgot/reset password) and **machines** (list, add, edit,
pause/resume, delete) go to the PisoWiFi API. Monitoring results, history, notifications and automations are
still the mock. In API mode the seeded demo machines never appear; real machines show a neutral dash (—) until a valid
check exists, "Run check" changes nothing, and the demo "Simulate state" control is hidden. The browser calls same-origin `/api/v1/*`, which `next.config.ts` proxies
to `API_ORIGIN` (default `http://127.0.0.1:4000`), so the HttpOnly session cookie stays first-party.

```bash
npm run dev:api                               # API with apps/api/.env (SESSION_COOKIE_SECURE=false for http)
NEXT_PUBLIC_DATA_SOURCE=api npm run dev        # web app on http://localhost:3000
```

Accounts come from `npm run user:create -w apps/api` (no sign-up page). There is no two-factor step. In mock
mode (default) the login form keeps the demo prefill and hint.

## Swapping in a backend

1. Implement `Services` from `lib/services/types.ts` (e.g. `lib/services/api/`) and select it in `lib/services/index.ts`
   via `NEXT_PUBLIC_DATA_SOURCE`.
2. Make it pass `tests/services.contract.test.ts` (call `runServiceContract()` with the new factory and a resettable fixture).
3. Read models (history and report aggregations in `lib/domain/*`) are synchronous over in-browser sample data today;
   with a backend, load that data through a data-fetching hook and keep the domain functions for shaping it.

## Testing notes

- Next.js (Cache Components) keeps recently visited routes mounted but hidden (`display: none`). Form fields therefore
  get unique DOM ids (`useFieldId`), and e2e selectors must be visibility-aware: `getByRole`, or
  `.filter({ visible: true })` for label/text lookups. After an action that navigates, wait for the URL before
  interacting again: Playwright keeps waiting on an element that becomes hidden instead of re-querying it.

## Remote Administration

`/remote` (`components/features/remote/`, rules in `lib/domain/remote.ts`):

- **Setup wizard per device**, tabs for Windows PC and Android phone: install ZeroTier One (official links only),
  join the network (`NEXT_PUBLIC_ZT_NETWORK_ID`, or the machine's own network ID; "ask your administrator" when
  neither is set), **pending authorization** (an administrator approves the device in ZeroTier Central; an optional
  helper copies an authorization request with the device's ZeroTier address, which is never saved or sent),
  Android only: switch the network on and approve the VPN permission, then test by opening a machine's admin page.
- **No fake detection.** A web page can't see whether ZeroTier is installed, running or authorized on its device,
  so each step is confirmed by the user ("I've completed this step"), and after opening the admin page the user
  says whether the WiFi5Soft login loaded. Progress is stored per browser (`localStorage`, `pw-remote-setup`),
  because setup belongs to the device. The OS tab is preselected from the user agent (a guess about the OS only).
- **Remote access ready / connection failed / troubleshooting**: once confirmed, "Open admin page" opens
  `http://<ZeroTier IP><admin path>` in a new tab (`noopener,noreferrer`; never an iframe). A failed attempt
  compares with the server-side monitoring result (machine up → look at this device's ZeroTier) and offers retry
  and re-checking the authorization steps. Troubleshooting covers VPN permission, ACCESS DENIED, offline network,
  unreachable private IP and WiFi5Soft sign-in.
- **Mock mode** simulates the open (a toast names the URL; nothing is requested). **API mode** really opens the link;
  only Admins see the open action (the WiFi5Soft login is the device's own gate either way).
- The WiFi5Soft login is never bypassed, filled in or stored. ZeroTier Central tokens never reach the browser.
- Future: the server could read authorized members through the ZeroTier Central API, but that still wouldn't prove
  the browser in use belongs to that member, so the user confirmation stays.
- **Disabled mode** (`NEXT_PUBLIC_REMOTE_MODE=disabled`, also the result for missing or invalid values): the web app shows an unavailable state and provides no Remote Administration actions. Staging must also set `REMOTE_GATEWAY_ENABLED=false` on the API because the API ticket route remains reachable through the same-origin proxy.
- **Direct mode** requires explicit `NEXT_PUBLIC_REMOTE_MODE=direct`.
- **Gateway mode** (`NEXT_PUBLIC_REMOTE_MODE=gateway`): no wizard and no ZeroTier on the user's
  device. "Open admin page" asks the API for a one-time ticket and opens the ZeroTier gateway in a new tab
  (`components/features/remote/gateway-access.tsx`). Same Admin-only rule; the API decides. Handoff, popup-blocker
  fallback and error handling: `apps/api/README.md`, "Remote admin ticket handoff". Mock mode simulates it.

## Status model

Users see two connectivity statuses only, everywhere (Dashboard, My PisoWiFi, Machine Details, Monitoring History,
Remote Administration): **Reachable** (green, check icon) and **Unreachable** (red, x icon). `Machine.status` is
`"reachable" | "unreachable" | null`; `null` means no valid check yet and is shown as a neutral dash (—,
screen readers hear "No valid check yet"), not as a status (`ConnectivityBadge`). Internally the values stay
`reachable` (Reachable) / `unreachable` (Unreachable); other API states map to `null`
(`connectivityOf` in `@pisowifi/shared`). History events are status changes only, with no guessed causes. In the demo, "Simulate state → Monitoring failure" shows that a
failed check run keeps the last result. Planned alerts (Automations) are exactly two Gmail messages, on status
changes only: went Unreachable, and back Reachable, each with the machine name, IP, and the date and time in
Asia/Manila, UTC+8 (`manilaTime` in `lib/format.ts`). No daily or weekly reports.
