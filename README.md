# PisoWiFi Monitoring System

## Project Overview

**PisoWiFi Monitoring System** is a personal full-stack web application I built for my PisoWiFi (coin-operated
WiFi) business, to monitor and remotely manage my **WiFi5Soft** machines.

The application checks each machine's connectivity continuously (every 60 seconds by default) and shows whether it
is **Online** (reachable) or **Offline** (unreachable). It also opens each machine's existing WiFi5Soft
administration dashboard remotely. There I can check sales, CPU usage and other operational information without
being at the location. The app only opens that dashboard; it never reads or stores those figures itself.

When a machine goes offline or comes back online, an **n8n automation** sends a Gmail alert. Monitoring runs in the
cloud on a **Google Cloud Compute Engine** VPS, which reaches the machines over a private **ZeroTier** network.

**Stack:** Next.js 16 · React 19 · TypeScript · Fastify 5 · PostgreSQL 17 / Supabase · Drizzle ORM · Zod ·
n8n · ZeroTier · Google Cloud Compute Engine (Ubuntu) · Vitest · Playwright · GitHub Actions

## Highlights

- **n8n automation for outage and recovery alerts.** The backend writes each verified Online ↔ Offline change to a
  database outbox and delivers it to an n8n webhook with Bearer auth and an HMAC-SHA256 signature. Failed deliveries
  are retried with exponential backoff and survive restarts. The n8n workflow (versioned in
  [`apps/api/n8n/`](apps/api/n8n/)) checks each request, tracks delivery per recipient, and sends Gmail alerts. A
  retry only emails the recipients who have not received the alert yet.
- **Google Cloud deployment.** Hosted on a Google Cloud Compute Engine VM running Ubuntu. The monitoring worker
  runs there as a ZeroTier member, and the API sits behind a reverse proxy on the loopback interface. The deployment
  scripts and runbooks are kept out of this public repository.
- **Separate API and worker.** The HTTP API and the scheduled monitoring worker are separate processes. The worker
  refuses to start without a complete configuration. A PostgreSQL advisory lock stops check rounds from overlapping,
  even across restarts.
- **Security throughout:** Argon2id passwords, hashed session tokens in HttpOnly cookies, CSRF origin checks, rate
  limits, an audit log, least-privilege database roles with row-level security (RLS), and strict outbound target
  rules for every machine check.

## Features

| Area | What is implemented |
| --- | --- |
| **Monitoring worker** | Checks every registered WiFi5Soft machine on a schedule (default every 60 s) by sending one HTTP request to its admin page over ZeroTier. Before marking a machine Offline, it confirms its own ZeroTier node is online, so a problem on the monitoring side never counts as a machine outage. Old checks can be pruned automatically (optional). |
| **Status transitions** | Two statuses shown to users: **Online** and **Offline**. Each change is recorded in a single database transaction: the check result, the new status, an event, an outage opened or closed, and a queued notification. Machines that have never been checked show a neutral dash instead of a status. |
| **Monitoring history** | A read-only history endpoint and page: uptime per machine, a status timeline, recent checks, status changes and outages, for any window up to 31 days. |
| **Machine management** | Add, edit, pause/resume and delete machines. Names and ZeroTier IPs are validated and must be unique. Every change is audited. |
| **Authentication & RBAC** | Email and password sign-in with no public registration. Includes session management, password reset by email, and account lockout. Two roles, **Administrator** and **Member**, with permissions enforced by the API. Administrators manage users (create an account with a one-time set-password link, change role, deactivate) and view the audit log. A database trigger keeps at least one active Administrator at all times. |
| **Remote administration** | Two modes, both off by default. **Direct:** each user joins ZeroTier on their own device (a setup wizard covers Windows and Android) and opens the machine's WiFi5Soft admin page. **Gateway:** the API issues a short-lived, single-use, Ed25519-signed ticket for a separate ZeroTier gateway service, which is not in this repository. Either way, the WiFi5Soft login is still required. |
| **n8n → Gmail alerts** | Emails for Online → Offline (Alert) and Offline → Online (Recovery), with time in the Asia/Manila zone and the downtime when it is known. Recipients are the active accounts. A per-user opt-out can be stored in the database, but there is no setting for it in the app yet. Off by default (`N8N_ENABLED`). |

**Not built yet:** The Reports page and the Automations settings page are UI previews. With the real API they show
"coming soon" or demo-only labels. Customer internet connectivity and ZeroTier Central integration are not built.

## Architecture

```
 Browser ──HTTPS──► Reverse proxy ──► Next.js web app (apps/web)
                          │                 │ same-origin /api/v1 proxy
                          └───────────────► Fastify API (apps/api) ──► PostgreSQL / Supabase
                                                                          ▲
 Monitoring worker (apps/api/src/worker.ts) ───────────────────────────────┘
   ├─ ZeroTier ──► WiFi5Soft admin page on each machine (HTTP check)
   └─ outbox dispatcher ──► n8n webhook ──► Gmail alerts
```

| Path | Contents |
| --- | --- |
| [`apps/web/`](apps/web/) | Next.js App Router frontend (TypeScript, Tailwind CSS v4, Radix/shadcn, Zustand). Runs on the real API or on built-in demo data. |
| [`apps/api/`](apps/api/) | Fastify API, monitoring worker, Drizzle schema and SQL migrations, n8n workflow. Full details in [`apps/api/README.md`](apps/api/README.md). |
| [`packages/shared/`](packages/shared/) | Zod schemas and types shared by the web app and the API (machines, auth, permissions, history, notifications). |
| [`design-reference/`](design-reference/) | The approved design system and interactive prototype that the UI follows. |
| `docker-compose.yml` | PostgreSQL 17 for local development (bound to localhost). |

## Getting started

Requires Node.js 20.9+ (CI uses Node 22).

```bash
npm install                                    # installs all workspaces and builds packages/shared
cp apps/web/.env.example apps/web/.env.local
npm run dev:mock                               # API + web app on demo data (sign in with password "demo")
```

To use a real database and real sign-in:

```bash
cp .env.example .env && docker compose up -d   # local PostgreSQL
cp apps/api/.env.example apps/api/.env         # set DATABASE_URL etc.
npm run db:migrate -w apps/api
npm run user:create -w apps/api -- --email you@example.com --name "Your Name" --role admin
npm run dev                                    # API on :4000, web on :3000
```

Monitoring, remote administration and n8n alerts are each **off by default** and turned on through environment
variables. They are documented in [`apps/api/README.md`](apps/api/README.md) and the `.env.example` files. The
worker also needs a host that is an authorized member of the ZeroTier network.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` / `npm run dev:mock` | API and web app together (real API data / demo data) |
| `npm run dev:api` / `npm run dev:worker` | API / monitoring worker in watch mode |
| `npm run lint` · `npm run typecheck` | ESLint and TypeScript checks for all workspaces |
| `npm run test` | Vitest: web unit, contract and component tests; API tests (PGlite, or real PostgreSQL via `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright end-to-end flows against a production build |
| `npm run test:visual` | Pixel comparison of every screen against the approved prototype (run locally) |
| `npm run build` · `npm run verify` | Production builds · lint + type-check + tests + build |

**CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, type-check, migration checks and tests
against a PostgreSQL 17 service, then builds and runs the Playwright end-to-end flows.

## Security notes

- Secrets, `.env` files, key material and deployment runbooks are excluded from this repository.
- The API listens on `127.0.0.1` and is reached only through the reverse proxy and the web app's same-origin proxy.
- The Supabase runtime role can read and write data but cannot change the schema; RLS is enabled on every table.
  Remote database connections require verified TLS.
- Machine checks only go to registered addresses inside an allowed ZeroTier range. Requests never supply a target,
  and redirects are never followed.
