# PisoWiFi Monitoring

Monitoring and (future) remote management for WiFi5Soft PisoWiFi machines.

| Path | Contents |
| --- | --- |
| `apps/web/` | Next.js frontend (App Router, TypeScript, Tailwind CSS, Radix/shadcn). Mock data only. |
| `apps/api/` | Node.js backend: Fastify API and monitoring worker (milestone B0 scaffold: config, logging, health checks, DB connection). |
| `packages/shared/` | Shared types and Zod schemas (machines, statuses, auth contracts, API errors, pagination) used by web and API. |
| `docker-compose.yml` | PostgreSQL 17 for local development and the VPS (bound to 127.0.0.1). |
| `design-reference/pisowifi-monitoring-design-system/` | Approved Claude Design export: tokens, component CSS, screen previews, interactive prototype (`reference/pisowifi-monitoring-prototype.html`). Source of truth for the UI. |
| `design-reference/prototype-export/` | The same prototype as a standalone page (named "PisoWiFi Monitor"; the approved name is "PisoWiFi Monitoring"). |

The API has authentication, account management, machine management and on-demand admin-HTTP checks of the
machines over ZeroTier, optional scheduled checks, and status-change emails through n8n → Gmail (Online ↔
Offline only; see `apps/api/README.md`). Users see two statuses: **Online** (green) and **Offline** (red).
**Deployment dependency:** monitoring checks only work from a host that is itself an authorized, online ZeroTier
member. Deploying the API to the cloud does not give it that access by itself (details in `apps/api/README.md`).

**Remote administration is direct ZeroTier client access.** Each person's own Windows PC or Android phone runs
ZeroTier One, joins the private network and is authorized by an administrator in ZeroTier Central; the app then
opens the machine's own WiFi5Soft admin page (`http://<ZeroTier IP>/admin`) in a new tab, where the original
WiFi5Soft login is still required. The app never proxies, frames or signs in to that page. Remote Administration has a
setup wizard for both platforms (steps the user confirms: a browser can't detect ZeroTier).

## Getting started

```bash
npm install                                   # installs all workspaces and builds packages/shared
cp apps/web/.env.example apps/web/.env.local  # NEXT_PUBLIC_DEMO_MODE=true
# apps/api/.env: database, SMTP etc. (see apps/api/README.md); accounts: npm run user:create -w apps/api
npm run dev                                   # API :4000 + web :3000 (real sign-in), one terminal
npm run dev:mock                              # same, web app on demo data (password "demo")
```

`npm run dev` (`scripts/dev.mjs`) labels output `[API]` / `[WEB]`; Ctrl+C stops both, and only those two.
It sets `NEXT_PUBLIC_DATA_SOURCE=api` for the web app unless you already set it in your shell; no `.env` file is
changed. Before starting it checks that ports 4000 and 3000 are free and that no other Next.js dev server is
running for this project (Next.js allows one per project). If either check fails it says so and exits, without
stopping anything. Other ports: `DEV_API_PORT=4100 DEV_WEB_PORT=3100 npm run dev`.

## Scripts (run from the root)

| Script | Does |
| --- | --- |
| `npm run dev` | API + web dev servers together (web on the API data source) |
| `npm run dev:mock` | API + web dev servers, web on the mock data source |
| `npm run dev:web` | Web dev server only (data source from `apps/web/.env*`, mock by default) |
| `npm run dev:api` / `npm run dev:worker` | API / monitoring worker in watch mode |
| `npm run lint` | ESLint (all workspaces) |
| `npm run typecheck` | Type-check (all workspaces) |
| `npm run test` | Vitest (all workspaces): web unit/contract/component tests, API tests |
| `npm run test:e2e` | Playwright end-to-end flows against a production build (uses installed Google Chrome; `PW_CHANNEL=chromium` for Playwright's browser) |
| `npm run test:visual` | Pixel comparison of every screen against the approved prototype (light/dark, 1440/390 px). Report: `apps/web/e2e/.artifacts/visual/report.md` |
| `npm run build` | Production builds (web and API) |
| `npm run verify` | Lint, type-check, unit tests and build |

CI (`.github/workflows/ci.yml`) runs the checks and the end-to-end flows. The visual comparison runs locally because font rendering differs between operating systems.
