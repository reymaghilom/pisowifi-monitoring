# PisoWiFi Monitoring: API and monitoring worker

Node.js + TypeScript backend (Fastify 5, PostgreSQL via node-postgres and Drizzle ORM, Zod).
**Milestones B0–B4, B6.** Configuration, logging, security headers, health checks, the database schema, SQL
migrations, **authentication** (email + password, sessions, roles), **account management** (profile, password,
sessions, password reset by email) and **machine management** (WiFi5Soft machines, Admin-only writes) exist.
The dedicated worker performs scheduled WiFi5Soft admin HTTP checks when explicitly enabled.

## Processes

Run the API and worker as **separate processes**. Only the worker needs to be on a ZeroTier-enabled host:

| Process | Entry | Purpose |
| --- | --- | --- |
| API | `src/server.ts` | HTTP API under `/api/v1`, bound to `HOST:PORT` (127.0.0.1:4000) behind the reverse proxy. Manual checks and queued notification delivery remain available. It never starts a scheduled checker. |
| Worker | `src/worker.ts` | Sole scheduled checker and optional n8n notification dispatcher. Requires ZeroTier node health, database access and `MONITOR_SCHEDULE_ENABLED=true`. No HTTP listener and no remote ticket-signing key. |

## Run

```bash
cp apps/api/.env.example apps/api/.env       # adjust DATABASE_URL etc.
cp .env.example .env && docker compose up -d # PostgreSQL 17 on 127.0.0.1:5432 (optional for B0)

npm run dev:api      # from the repo root: tsx watch
npm run dev:worker
npm run build -w apps/api && npm run start -w apps/api   # compiled output (dist/)
npm run start:worker -w apps/api                         # dedicated checker, only after configuring it
```

Without a database the API still starts: `/readyz` reports `not_ready`.

## Database (B2)

Drizzle schema in `src/db/schema/`, SQL migrations in `drizzle/` (committed). Enum values and length limits come
from `@pisowifi/shared`, so the database and the API contracts can't drift apart.

| Area | Tables |
| --- | --- |
| Auth | `users` (role `admin` \| `viewer`, Argon2id hash, failed-login counter and lock), `sessions`, `password_reset_tokens`, `audit_log` |
| Machines | `machines` (optional backend-only `zt_member_id`), `machine_state` (four separate signals: `http_status`, `zt_state`, `internet_state`, `monitor_health`) |
| History | `checks`, `events`, `outages`, `check_rollups_hourly` |
| Settings | `monitoring_settings` (single row, seeded: 60 s / 5 s / 3 misses), `notification_prefs` |

Integrity and security:
- Session and reset tokens are stored only as **SHA-256 digests** (`bytea`, exactly 32 bytes,
  unique). The raw values never reach the database.
- Case-insensitive unique email and machine name (`lower()` indexes, no extension required); unique ZeroTier IP,
  IPv4 host addresses only; member ID unique within its network; formats and lengths checked in SQL.
- One open outage per machine (partial unique index); successful checks carry no error and failed ones say why;
  rollup buckets are whole UTC hours.
- Cascades: deleting a user removes their sessions and tokens (audit entries keep a null user); deleting a machine
  removes its state and history.
- Time series: `(machine_id, time DESC)` indexes on checks and events, BRIN on check time for retention deletes,
  hourly rollups for charts.

| Script | Does |
| --- | --- |
| `npm run db:generate -w apps/api` | Generate a migration from schema changes |
| `npm run db:migrate -w apps/api` | Apply migrations (`DATABASE_URL`; use a role allowed to change the schema) |
| `npm run db:migrate:prod -w apps/api` | Same, from the compiled output |
| `npm run db:check -w apps/api` | Validate the migration history |
| `npm run db:provision-app-role -w apps/api` | Enable login for `pisowifi_app` (`APP_DB_PASSWORD`, migration credentials) |
| `npm run user:create -w apps/api -- --email … --name "…" --role admin` | Create an account (hidden password prompt) |
| `npm run user:set-password -w apps/api -- --email …` | Set a new password; unlocks and signs out all sessions |
| `npm run user:list -w apps/api` | List accounts (role, last sign-in, lock) |
| `npm run gateway:check -w apps/api` | Real admin HTTP check of every registered WiFi5Soft machine through ZeroTier (`-- --dry-run` contacts nothing) |

Migration tests (`tests/migrations.test.ts`) apply the real SQL and check constraints, defaults, cascades and index
use on **PGlite** (in-process PostgreSQL), and also on a real server when `TEST_DATABASE_URL` is set (CI: PostgreSQL 17).

## Supabase (hosted PostgreSQL, milestone S1)

Supabase is used **as the database only**. Authentication is custom (B3, `src/auth/`); Supabase Auth, the Data API and
service keys are not used.

**Project settings (dashboard)**
- Turn the **Data API off** (or remove `public` from exposed schemas). Migration 0002 also revokes everything from
  `anon`/`authenticated`, so the tables stay closed even if it is switched back on.
- Keep SSL enforcement on. Download the **CA certificate** for `DATABASE_SSL_CA`.
- Network restrictions: none yet. **Restrict to the VPS IP once it is known.** Until then, access is protected by
  verified TLS, strong passwords and least-privilege roles.
- Use a separate **development project** for migrations tests and staging.

**Credentials (two roles)**

| Role | Used by | Connection | Rights |
| --- | --- | --- | --- |
| `postgres` (owner) | `db:migrate`, `db:provision-app-role` | `MIGRATION_DATABASE_URL`: session pooler, port 5432, user `postgres.<project-ref>` | Schema changes |
| `pisowifi_app` | API, worker | `DATABASE_URL`: transaction pooler, port 6543, user `pisowifi_app.<project-ref>` | Read/write data only; no DDL or TRUNCATE; audit log append-only; RLS policies; timeouts (statement 15 s, lock 5 s, idle-in-transaction 30 s) |

**Setup order**
1. `.env`: `MIGRATION_DATABASE_URL`, `DATABASE_SSL=verify`, `DATABASE_SSL_CA`.
2. `npm run db:migrate -w apps/api` (creates tables, the NOLOGIN `pisowifi_app` role, grants and RLS policies).
3. `APP_DB_PASSWORD=$(openssl rand -base64 32) npm run db:provision-app-role -w apps/api`: enables login with a
   SCRAM-SHA-256 verifier computed locally (the plaintext is never sent to the server or logged).
4. Put that password in `DATABASE_URL` (user `pisowifi_app.<project-ref>`, port 6543) and remove `APP_DB_PASSWORD`.
5. `GET /api/v1/readyz` → `{"status":"ready","db":"up"}`.

**Transaction pooler rules** (tested in `tests/pooler.test.ts`)
- Drizzle sends unnamed statements; named prepared statements (`.prepare()`) are banned by ESLint in `src/`.
- No session state on runtime connections: no `SET` (role defaults cover timeouts), no `LISTEN/NOTIFY`, no session
  advisory locks. The future job queue (B8) will use the session pooler.

**Security rules enforced at startup** (`src/config/env.ts`)
- Remote databases require `DATABASE_SSL=verify` with a CA file; plain connections only to localhost
  (local Docker / local PostgreSQL development stays possible).
- TLS parameters inside URLs (`sslmode`, `sslrootcert`, …) are rejected, because node-postgres would let them
  override the certificate check.

**New tables** must enable RLS and add a `pisowifi_app` policy; `tests/migrations.test.ts` fails otherwise.

## Endpoints

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/v1/healthz` | `200 {status:"ok", version, uptime}`: the process is alive |
| GET | `/api/v1/readyz` | `200 {status:"ready", db:"up"}`, or `503 {status:"not_ready", db:"down" \| "not_configured"}` |
| POST | `/api/v1/auth/login` | `{email, password, remember}` → `200 {user}` + session cookie; `401` generic; `429` rate limit / lock |
| POST | `/api/v1/auth/logout` | `204`; revokes the session and clears the cookie |
| GET | `/api/v1/auth/me` | `200 {user}` for a live session, otherwise `401` |
| POST | `/api/v1/auth/password-reset` | `{email}` → `202` for any email (no enumeration); `503` while email is disabled |
| POST | `/api/v1/auth/password-reset/confirm` | `{token, password}` → `204`; `400 invalid_token` for used/expired/unknown links |
| PATCH | `/api/v1/account/profile` | `{displayName, email}` → `200 {user}`; `409` when another account uses the email |
| POST | `/api/v1/account/password` | `{currentPassword, newPassword, confirmPassword}` → `200 {revoked}` (other sessions signed out) |
| GET | `/api/v1/account/sessions` | `200 {items:[{id, label, current, createdAt, lastSeenAt}]}` (live sessions only) |
| DELETE | `/api/v1/account/sessions/:id` | `204`; `404` if not yours or already gone; `400` for the current session (use sign-out) |
| POST | `/api/v1/account/sessions/revoke-others` | `200 {revoked}` |
| GET | `/api/v1/machines?q=&status=&sort=` | `200 {items:[machine]}`; any signed-in user |
| GET | `/api/v1/machines/:id` | `200 machine`; `404` |
| POST | `/api/v1/machines` | Admin. `201 machine`; `400` field errors; `409` duplicate name (ignoring case) or IP |
| PUT | `/api/v1/machines/:id` | Admin. `200 machine`; same errors |
| PATCH | `/api/v1/machines/:id/monitoring` | Admin. `{enabled}` → `200 machine` |
| DELETE | `/api/v1/machines/:id` | Admin. `204`; removes its state and history |
| GET | `/api/v1/history?from=&to=&buckets=&machine=` | Any signed-in user. Read-only history from recorded checks (`historyResponseSchema`). Per machine: measured totals (uptime = checks that reached it ÷ valid checks), `buckets` even slots of the window, a 48-slot `ok`/`bad`/`none` strip (`none` = no valid check, never Reachable) and the 20 latest checks. Also status changes and outages in the window. At most 31 days; data stops at now. `400`, `404` unknown machine |
| POST | `/api/v1/remote/machines/:id/ticket` | Admin. `200 {entryUrl, expiresAt}` one-time gateway link; `404`, `422`, `503` when the gateway is off (see below) |

`user` is `{id, email, displayName, role}`. There is **no registration endpoint** and **no two-factor step**.

## Authentication (B3)

Email + password for a small fixed set of accounts (single workspace). Code in `src/auth/`.

- **Accounts** are created only from the server shell (`user:create`); passwords are typed at a hidden prompt
  (or piped with `--password-stdin`), never passed as arguments or printed. Roles: `admin` (manages machines and
  settings) and `viewer` (read-only). Routes protect themselves with `app.auth.requireAuth` / `app.auth.requireAdmin`.
- **Passwords**: Argon2id (m=19456 KiB, t=2, p=1; OWASP baseline), 12–256 characters. Hashes with older
  parameters are upgraded at the next sign-in. Unknown emails spend the same hashing time as wrong passwords, and
  both get the same message.
- **Sessions**: 256-bit random token in an **HttpOnly, SameSite=Lax** cookie; only its SHA-256 is stored.
  `remember` → persistent 30-day cookie, otherwise a browser-session cookie that the server expires after 12 h.
  Rotated at every sign-in; sign-out and `user:set-password` revoke immediately. With `SESSION_COOKIE_SECURE`
  (default in production, required there) the cookie is `__Host-pisowifi_session` with `Secure`.
- **Brute force**: `LOGIN_RATE_LIMIT` sign-in attempts per IP per 15 minutes (in memory, per API process), and
  5 wrong passwords lock the account for 15 minutes (`user:set-password` unlocks). Behind a reverse proxy set
  `TRUST_PROXY=true` so the limit applies to the client IP.
- **CSRF**: POST/PUT/PATCH/DELETE must carry `Origin: APP_ORIGIN` (or `Sec-Fetch-Site: same-origin`), otherwise `403`.
  The web app calls the API same-origin through its `/api/v1` proxy (`apps/web/next.config.ts`).
- **Planned Caddy route**: send `/api/v1/*` directly to the loopback API without stripping the path, and all other
  paths to Next.js. Before setting `TRUST_PROXY=true`, verify that Caddy replaces untrusted forwarding headers and
  sends the real client IP as the closest `X-Forwarded-For` entry. A local process connecting directly to the
  loopback API can impersonate that proxy, so VM shell access remains a trusted boundary.
- **Audit**: sign-in success/failure/lock, sign-out, account creation and password changes go to `audit_log`.

First accounts (once per environment):

```bash
npm run user:create -w apps/api -- --email you@example.com --name "Your Name" --role admin
npm run user:create -w apps/api -- --email partner@example.com --name "Partner" --role admin
```

In Git Bash on Windows, run these from PowerShell (or prefix with `winpty`) so the hidden prompt gets a terminal.

## Account management (B4)

Code in `src/account/routes.ts` and `src/auth/password-reset.ts`; every `/account/*` route needs a live session.

- **Profile**: display name and sign-in email (unique ignoring case). Changing the email notifies the old address.
- **Password change**: requires the current password (wrong → field error, audited; 10 attempts per IP per 15 min).
  On success this session stays, every other session is revoked, pending reset links stop working and the owner
  is notified.
- **Sessions**: live sessions with a device label from the user agent ("Chrome on Windows"), current one flagged;
  revoke one or all others. Users can only see and revoke their own.
- **Password reset**: one-time link, valid 30 minutes, 256-bit token stored as SHA-256, carried in the URL
  fragment (`/reset-password#token=…`) so it never reaches server or proxy logs. A new request replaces older
  links; at most 3 per account per hour and 5 requests per IP per 15 minutes. Unknown emails get the same `202`.
  Completing a reset unlocks the account, revokes every session and notifies the owner.
- **Email** (`src/mail/`): any SMTP provider, plain-text messages, implicit TLS or mandatory STARTTLS (TLS 1.2+,
  certificate verified). **Nothing is sent unless `SMTP_ENABLED=true`**; until then password reset answers `503`
  with "ask an admin", and an admin uses `user:set-password`. Check settings with
  `npm run mail:test -w apps/api -- --to you@example.com` (refuses while disabled).

Unknown routes return `404 {error:{code:"not_found", message}}`. Errors use the same `{error:{code, message}}`
shape; internal details are hidden in production.

## Machine management (B6)

Code in `src/machines/routes.ts`; contract `machineInputSchema` / `machineSchema` in `@pisowifi/shared`.

- **WiFi5Soft only**: `software` must be `WiFi5Soft` (the default). The database enum still contains `Other`
  for compatibility; the API refuses it for new and edited machines.
- **Access**: any signed-in user can list and view; create, edit, pause/resume and delete are Admin-only (`403`
  for viewers). Writes also pass the CSRF Origin check.
- **Validation and duplicates**: shared rules and messages (name, IPv4 ZeroTier IP, admin path, optional 16-hex
  network ID, up to 8 tags). Name (ignoring case) and IP must be unique: `409` with the field, also for races
  caught by the unique indexes.
- **ZeroTier member ID** stays backend-only: not in the form, kept on edit, cleared if the network ID is removed.
- **Honest state**: a machine's state comes only from `machine_state`. New machines have no valid check
  (`unknown`, no timestamps; shown as a neutral dash); pausing sets monitoring health to Paused, resuming to
  Unknown. Nothing here contacts a machine or ZeroTier, and no endpoint sets an HTTP or ZeroTier status (that is
  the monitor's job, B8).
- **Audit**: `machine.created`, `machine.updated` (with the changed fields), `machine.monitoring_paused` /
  `_resumed`, `machine.deleted` (name and IP kept), each targeting the machine.

## ZeroTier gateway checks (Phases Z1, PC2)

The API host is a ZeroTier member and checks registered machines' WiFi5Soft admin interfaces: an always-running
data source for monitoring, which a browser alone can't be. **Remote administration does not go through the API**:
it is direct ZeroTier client access (each person's own device joins ZeroTier and opens `http://<ZeroTier IP>/admin`
itself; see `apps/web/README.md`). The API serves no proxy, sessions or capability URLs.
Code in `src/gateway/`; contracts in `@pisowifi/shared` (`gateway.ts`). Off by default.

| Route (prefix `/api/v1`) | Who | Does |
| --- | --- | --- |
| `GET /gateway/status` | Admin | Gateway node state: `disabled` / `online` / `offline` / `unknown` (no addresses or tokens) |
| `POST /gateway/machines/:id/check` | Admin | Live check of a registered WiFi5Soft machine: gateway, admin HTTP, internet (always `unverified`) as separate fields; recorded (below). 30/min |
| `POST /gateway/check` | Admin | Same for every registered WiFi5Soft machine, `GATEWAY_MAX_CONCURRENCY` at a time. 6/min |
| `GET /machines`, `GET /machines/:id` | any signed-in user | Read the recorded results (`state.http`, `lastCheckAt`, `lastSuccessAt`) |

Security model
- **Targets only from records**: the address is the registered machine's `ztIp` + `adminPath`; scheme and port are
  server settings. Requests never carry a host, IP, port or URL. IPv4 literals only (no DNS), inside
  `ZT_ALLOWED_CIDRS`; loopback, link-local/metadata, "this network", multicast and reserved ranges are always
  refused. The checked path is re-resolved and must stay on the target (no traversal, `//host`, control chars).
- **One bounded GET, no redirects**: redirects are never followed; nothing is submitted, so device credentials
  are never involved.
- **Two results only**: any HTTP answer (any status, even 5xx) = reachable; no answer = unreachable, but only
  when this host's own ZeroTier node is confirmed online (`ZT_AUTHTOKEN_FILE` set and the node online). Strict
  timeout, ≤ 64 KB read. Customer internet is never verified by the gateway.
- **Monitoring failures never blame the machine**: gateway disabled or offline, target refused, or no answer while
  the node's own state can't be confirmed → nothing is recorded and the last valid result stays
  (`refusal: gateway_unverified` etc. in the live answer).

Recorded results (Phase PC2, `src/gateway/checker.ts`): a valid result adds a `checks` row (`trigger = manual`)
and updates only the admin HTTP signal in `machine_state` (status, last check, last success, consecutive failures).
Machines without a valid check stay `unknown`, which the web app shows as a neutral dash (—), never as a status.
`stale` and `error` remain in the database enum for compatibility only; nothing writes them.
Customer internet stays `unverified`; ZeroTier sighting and monitor health
are not touched. An HTTP answer from `/admin` proves the admin interface answers, not that customers are online, and
no CPU, sales or customer figures are read.

Scheduled checks run only in the dedicated worker when enabled. A remote admin proxy (Phase R1) was built and then dropped in favour of
direct client access; it is parked on the `r1-remote-proxy` branch for reference.

## Remote admin ticket handoff (gateway mode)

An alternative to direct ZeroTier client access, **off by default on both sides**: the API needs
`REMOTE_GATEWAY_ENABLED=true` (with `REMOTE_GATEWAY_ORIGIN` and `REMOTE_TICKET_PRIVATE_KEY_FILE`, see
`.env.example`) and the web app needs `NEXT_PUBLIC_REMOTE_MODE=gateway`. The ZeroTier gateway itself is a
separate repository (`pisowifi-zerotier-gateway`). With either side off, nothing here is used.

The authentication model is unchanged. The ticket endpoint is an ordinary Admin route: the session cookie, the
Admin role and the CSRF Origin check decide everything, exactly as for machine writes. The web app's setting only
changes what the Remote Administration page shows; it grants nothing.

`POST /api/v1/remote/machines/:id/ticket` (no body; the API reads the machine's `ztIp` and `adminPath` from its
record, WiFi5Soft machines only):

| Status | When |
| --- | --- |
| `200 {entryUrl, expiresAt}` | `entryUrl` is `<gateway origin>/__pisowifi/enter#t=<ticket>` (schema in `@pisowifi/shared`, `remote.ts`) |
| `401` / `403` | No live session / not an Admin |
| `404` | Unknown machine, or not WiFi5Soft |
| `422 invalid_machine` | The record's ZeroTier IP or admin path can't be opened through the gateway |
| `429` | More than 20 per minute |
| `503 unavailable` | `REMOTE_GATEWAY_ENABLED` is not true |

The ticket is an Ed25519-signed, single-use bearer credential for one user and one machine, valid for
`REMOTE_TICKET_TTL_S` seconds (default 60, at most 120). Responses are `no-store`; the ticket is never logged or
stored, and each issue is audited as `remote.ticket_issued` with its `jti` only. The API never carries admin
traffic.

Browser handoff (`apps/web`, `lib/services/api/remote.ts` and `components/features/remote/gateway-access.tsx`):

1. On "Open admin page" the browser opens a blank tab **synchronously in the click** (before any request), so
   popup blockers in desktop Chrome, mobile Chrome and Safari allow it, and immediately sets its `opener` to `null`
   (no reverse tabnabbing).
2. It then requests the ticket (`credentials: same-origin`, `no-store`, `no-referrer`) and validates the answer
   against the shared schema.
3. Success: the blank tab is navigated with `location.replace(entryUrl)`. The ticket is in the URL fragment, which
   browsers never send to a server or in a `Referer`.
4. Any failure (401, 403, 404, 422, 429, 503, network, malformed answer): the blank tab is closed and the page
   shows the reason with a retry.
5. Popup blocked (or the user closed the blank tab while waiting): the page offers the one-time link as an explicit
   user action, either a link to a new tab (`rel="noopener noreferrer"`, `referrerpolicy="no-referrer"`) or
   navigating this tab. The link is removed when used, when another machine is selected, or when it expires.

The web app never logs, stores, toasts or sends the ticket anywhere but that tab, and has no analytics.

### Windows gateway host (Phase PC2)

The Windows PC running the API can be the gateway: it is already a ZeroTier member (`192.168.194.22`). In
`apps/api/.env`:

```env
GATEWAY_ENABLED=true
ZT_ALLOWED_CIDRS=192.168.194.0/24
# Optional node health. ZeroTier One copies the service token here for the signed-in user (no admin rights needed);
# the original is C:\ProgramData\ZeroTier\One\authtoken.secret (Administrators only).
ZT_AUTHTOKEN_FILE=C:/Users/<you>/AppData/Local/ZeroTier/authtoken.secret
ZT_NETWORK_ID=8286ac0e4705c5aa
```

Restart the API yourself after changing `.env`.
Check from the shell with the same rules as the app (registered WiFi5Soft machines only; results are recorded):

```bash
npm run gateway:check -w apps/api -- --dry-run   # targets and refusals, contacts nothing
npm run gateway:check -w apps/api                # one bounded GET of each machine's admin path
```

Exit code 0 = every machine answered over HTTP, 2 = some did not, 78 = gateway or database not configured.

### Deployment dependency: the monitoring host needs ZeroTier access

The checks reach machines at their private ZeroTier IPs (192.168.194.x), so **whatever host runs them must itself be
a joined, authorized and online ZeroTier member**, with `ZT_AUTHTOKEN_FILE` set (otherwise failures can't be
confirmed and are not recorded). Cloud hosting alone does not provide this: a typical PaaS or serverless platform
(no persistent ZeroTier service, no TUN device or root) cannot reach the machines at all. Options: keep the checks on
this Windows PC (today's setup; monitoring stops while the PC is off), or a VM/VPS where ZeroTier One can be installed
and run as a service. That host is for monitoring only, never for remote admin traffic.

**Moving the checks to another always-on host (needs your approval; nothing here was done):** install ZeroTier on that
host, join the network, authorize it in ZeroTier Central, set `GATEWAY_ENABLED=true`,
`ZT_ALLOWED_CIDRS=192.168.194.0/24` and `ZT_AUTHTOKEN_FILE` (optionally `ZT_NETWORK_ID`), then run
`npm run gateway:check -w apps/api`.

## Status-change notifications (n8n → Gmail)

Two notifications only, both triggered by the **backend** after a verified status change is recorded (never by
the web app, demo data, UI actions or monitoring-side failures):

| Change | Event | Email subject |
| --- | --- | --- |
| Online → Offline | `machine.unreachable` | "[PisoWiFi Alert] <machine> is Offline" |
| Offline → Online | `machine.reachable` | "[PisoWiFi Recovery] <machine> is Back Online" |

The email says **Online** / **Offline** / **Back Online** (with Previous and Current Status, the Asia/Manila time, the event ID and, for Back Online, the downtime when an outage record exists); internally (API, database, event names) the values stay `reachable` /
`unreachable`, and the payload fields `status` / `previousStatus` keep their contract values `Reachable` /
`Unreachable`. A first result (no result → Online/Offline) and an unchanged status send nothing.
No daily or weekly reports, no Telegram, no causes.

**Recipients** (`src/notifications/recipients.ts`): every **active** account (`users.disabled_at` is null), in
sign-up order, at most 20. An optional `notification_prefs` row can turn one kind off for that user (`offline=false`
→ no Offline alerts, `recovery=false` → no Back Online alerts); no row means both on. The `email`, `telegram` and
`quiet_hours` columns are not consulted. Recipients are resolved **in the transaction that records the change** and
stored in the payload, so every retry targets the same people. Nobody to notify → no delivery is queued (the event is
still recorded). No migration was needed.

**How it works** (`src/gateway/checker.ts`, `src/notifications/`)
- A valid check that changes the stored status writes, in one transaction with the machine's state row locked: the
  check, the new state, an `events` row (`outage` / `recovery`), the `outages` row (opened / closed) and, when
  `N8N_ENABLED=true` and someone is to be notified, one `notification_deliveries` row (outbox). One row per event
  (unique key); nothing is queued while n8n is disabled (enabling it later does not replay old changes).
- The dispatcher (the worker in production) sends due rows right after a change and every 30 s:
  `POST N8N_WEBHOOK_URL` with the JSON payload (`notificationPayloadSchema` in `@pisowifi/shared`) and headers
  `Authorization: Bearer <N8N_WEBHOOK_SECRET>`, `X-PisoWiFi-Event-Id` (stable across retries),
  `X-PisoWiFi-Timestamp`, `X-PisoWiFi-Signature: sha256=<HMAC-SHA256 of timestamp.body>`. Server to server only; the
  URL, secret and recipient addresses are never logged.
- 2xx = sent. Anything else (timeout, network error, non-2xx, redirect) is retried with backoff (30 s, 1, 2, 4 …
  minutes, max 1 h) up to `N8N_MAX_ATTEMPTS` (default 12), then marked `failed`. Retry state is in the database, so it
  survives restarts; rows are claimed with `FOR UPDATE SKIP LOCKED` under a lease, and a crashed attempt is taken
  over after the lease expires.
- Per-recipient delivery state lives in n8n (below): a retry of a partially delivered event emails only the
  recipients still pending. Delivery is **at-least-once**, not exactly-once.

Payload example (addresses are test values):

```json
{
  "eventId": "6f0e1c2a-…", "event": "machine.unreachable",
  "machine": { "id": "…", "name": "Rey Pisowifi", "ip": "192.168.194.127" }, "status": "Unreachable", "previousStatus": "Reachable",
  "detectedAt": "2026-10-12T12:44:07.000Z", "detectedDate": "October 12, 2026", "detectedTime": "8:44 PM",
  "timeZone": "Asia/Manila", "utcOffset": "+08:00",
  "subject": "[PisoWiFi Alert] Rey Pisowifi is Offline",
  "text": "Rey Pisowifi is Offline.\n\nMachine: Rey Pisowifi\nPrevious Status: Online\nCurrent Status: Offline\nDetected: October 12, 2026, 8:44 PM (Asia/Manila)\n\nEvent ID: 6f0e1c2a-…",
  "recipients": [{ "id": "<user uuid>", "email": "rey@example.invalid" }, { "id": "…", "email": "cris@example.invalid" }, { "id": "…", "email": "member@example.invalid" }]
}
```

A Back Online payload also carries `outageStartedAt` and `downtimeSeconds`, read in the same transaction from the
`outages` row the change closes. Both are absent when there was no open outage record; downtime is never estimated.

### n8n workflow

**v4** (`n8n/pisowifi-status-workflow.v4.json`, built by `n8n/build-workflow-v4.mjs`) is the current workflow; setup
and the Gmail network requirement are in `docs/operations/n8n-v4-gmail-setup.md`. v3 (below) is kept unchanged for
reference.

v3: the importable workflow in `n8n/pisowifi-status-workflow.json` (setup, responses and limits:
`n8n/README.md`). It validates the request, loads per-(event, recipient) state from an n8n Data Table, emails each
pending recipient once (reserve → send → record), and answers 200 only when every recipient is done (503 otherwise,
so this API retries). Do not use a "Remove Duplicates before Gmail" design: it loses the alert when Gmail fails.
Keep `N8N_TIMEOUT_MS=30000` (longer than the workflow's 25 s execution timeout).

Gmail credentials live only in n8n; this app never sees them. The webhook URL and secret live only in the
dispatcher's environment; never commit them. Generate the secret with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Monitoring configuration (needed for automatic alerts)

Without the worker, changes are only detected by an Admin's gateway check or `npm run gateway:check`.
For cloud monitoring, configure the dedicated worker's environment:

```env
GATEWAY_ENABLED=true
ZT_ALLOWED_CIDRS=192.168.194.0/24
ZT_AUTHTOKEN_FILE=/path/to/authtoken.secret
ZT_NETWORK_ID=<existing ZeroTier network ID>
DATABASE_URL=<least-privilege runtime connection>
MONITOR_SCHEDULE_ENABLED=true                  # checks every monitoring_settings.interval_seconds (default 60 s)
REMOTE_GATEWAY_ENABLED=false                   # worker does not use the private signing key
N8N_ENABLED=true
N8N_WEBHOOK_URL=https://<your-n8n>/webhook/pisowifi-status
N8N_WEBHOOK_SECRET=<64 hex characters>
```

Run one worker service instance on an authorized ZeroTier VM. A transaction-scoped database lock also skips
overlapping rounds during restarts or rollouts. The lock is held for the full check round, so keep the two-device
round below the database role's idle-in-transaction timeout; use the default 5-second probe timeout. A failed lock
query skips the round without checking or changing status. Do not start the scheduler in the API process. Start
with `N8N_ENABLED=false` until status checks and the n8n event-ID deduplication workflow are verified.

The worker needs only the least-privilege database role, ZeroTier's local API token, network ID, target CIDR and
optional n8n webhook secret. It does not need `REMOTE_TICKET_PRIVATE_KEY_FILE`. The API can continue issuing
Remote Admin tickets in its separate process. Apply the existing notification table first if needed: `npm run
db:migrate -w apps/api` (migration `0004_notification_outbox`). Inspect deliveries with
`select status, attempts, last_error, created_at, sent_at from notification_deliveries order by created_at desc;`.

For rollout, stop any prior scheduled checker, start one worker with the settings above, and observe check timestamps
and verified states for both devices before enabling alerts. The web app reads stored machine state every 30 seconds
while signed in; a machine with no valid check displays a dash. For rollback, stop the worker or set
`MONITOR_SCHEDULE_ENABLED=false` before restarting it. Existing stored verified states remain intact. Neither action
changes the Remote Admin gateway.

## Configuration

Validated with Zod at startup (`src/config/env.ts`). An invalid environment exits with code 78 and lists the
problems without echoing values. See `.env.example`.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST` / `PORT` | `127.0.0.1` / `4000` | Keep the API private; expose it only through the reverse proxy |
| `LOG_LEVEL` | `info` | pino levels |
| `DATABASE_URL` | none | Required in production |
| `TRUST_PROXY` | `false` | `true` trusts exactly one immediate `127.0.0.1` Caddy hop; `HOST` must be `127.0.0.1` |
| `APP_ORIGIN` | `http://localhost:3000` | Exact web origin for CSRF; HTTPS required in production, including any `APP_EXTRA_ORIGINS` |
| `SESSION_COOKIE_SECURE` | `true` in production | `Secure` + `__Host-` cookie; `false` only for plain-http local development |
| `LOGIN_RATE_LIMIT` | `10` | Sign-in attempts per IP per 15 minutes |
| `SMTP_ENABLED` | `false` | Explicit approval to send email; requires `SMTP_HOST` and `SMTP_FROM` |
| `SMTP_HOST` / `SMTP_PORT` | none / `587` | Any SMTP provider |
| `SMTP_SECURE` | `true` if port 465 | `true`: implicit TLS; `false`: STARTTLS (required, never plain text) |
| `SMTP_USER` / `SMTP_PASS` | none | Set together; the password is redacted from logs |
| `SMTP_FROM` | none | e.g. `PisoWiFi Monitoring <no-reply@example.com>` |

| `GATEWAY_ENABLED` | `false` | ZeroTier gateway on/off; nothing contacts machines while off |
| `ZT_ALLOWED_CIDRS` | none | Required when enabled, e.g. `192.168.194.0/24` |
| `GATEWAY_TARGET_PORT` | `80` | WiFi5Soft admin port (server setting, never from requests) |
| `GATEWAY_TIMEOUT_MS` | `5000` | Check timeout per machine |
| `GATEWAY_MAX_CONCURRENCY` | `4` | Machines checked at once |
| `ZT_AUTHTOKEN_FILE` / `ZT_NETWORK_ID` / `ZT_LOCAL_API_URL` | none / none / `http://127.0.0.1:9993` | Gateway node health via the local ZeroTier service (required to record Unreachable) |
| `MONITOR_SCHEDULE_ENABLED` | `false` | Worker only; API ignores it. Worker also requires a database, local ZeroTier token and network ID. |
| `N8N_ENABLED` | `false` | Status-change notifications to n8n (Gmail); requires the two below |
| `N8N_WEBHOOK_URL` | none | n8n Webhook production URL, https (http only for loopback). Secret: never commit |
| `N8N_WEBHOOK_SECRET` | none | ≥ 32 characters; Bearer token and HMAC key. Secret: never commit, never logged |
| `N8N_WEBHOOK_SECRET_FILE` | none | Instead of `N8N_WEBHOOK_SECRET`: a file holding only the secret (production: systemd `LoadCredential`), 32–512 printable characters, one line. Not both |
| `N8N_TIMEOUT_MS` / `N8N_MAX_ATTEMPTS` | `10000` / `12` | Per-request timeout / attempts before a notification is marked failed |

Planned, optional, not read yet: `ZT_API_TOKEN` (ZeroTier Central), `ENCRYPTION_KEY`.

## Security baseline (B0, extended in B3)

- Helmet headers with the strictest CSP (`default-src 'none'`); no `X-Powered-By`
- Server-generated request ids (`x-request-id`); client-supplied ids are ignored
- Log redaction of `authorization`, `cookie`, `set-cookie`, passwords, tokens and secrets
- 1 MB body limit; generic 500 messages in production; graceful shutdown on SIGINT/SIGTERM

## Approved decisions carried into later milestones

- Single workspace; roles **Admin** and **Viewer**
- Email + password sign-in only, no public registration. **Two-factor authentication is not part of the
  product** (removed in B3, migration 0003) and is not planned
- Configurable SMTP for password reset
- `machines.zt_member_id` stays an **optional** backend field (future discovery via the ZeroTier API). It is
  not shown in the Add/Edit UI
- "Demo data" badges appear only in the frontend's mock mode
- **Two user-facing statuses** (decided 2026-10-12; worded Online / Offline since 2026-10-19): Online (green) and Offline (red), stored
  as `reachable` / `unreachable`. No stale/unknown/error
  categories, no ISP/power/root-cause reasons. Monitoring-side failures are kept internal and never change a
  machine's status.
- **n8n alerts by Gmail** (implemented, off by default): Online → Offline sends one "Offline" alert, Offline →
  Online one "Back Online" notification, to every active account, each with the machine name, IP, status, and the
  date and time in Asia/Manila (UTC+8). No other n8n workflows (no daily/weekly reports). Alerts fire on recorded status changes only, so no
  duplicate emails while the status stays the same. n8n failures never affect monitoring (outbox, separate retries).

## Not implemented yet

Frontend API services for monitoring preferences, notifications and automations (B7: the web Automations page is
still a preview and does not show real deliveries), check retention and rollups (B8), history and reports from
recorded data (B9), ZeroTier Central API (member authorization status) and internet verification. Remote admin is
direct ZeroTier client access by default (no proxy in the API, by design); the gateway ticket handoff above is
implemented but not enabled or deployed.

## Dependency advisories (reviewed in B2)

`npm audit` reports 9 advisories, all in **development tooling**; none is in the API or web runtime:

| Advisory | Path | Exposure | Decision |
| --- | --- | --- | --- |
| GHSA-vfj7-8cjw-p6xm, `braces` ≤ 3.0.3 (high, stack-exhaustion DoS on deeply nested patterns) | `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` | Only ESLint's own glob patterns reach it; no untrusted input | Keep. No patched `braces` exists yet (3.0.3 is the latest); npm's only "fix" downgrades `eslint-config-next` to 14.x, incompatible with Next 16 |
| GHSA-67mh-4wv8-2f99, `esbuild` ≤ 0.24.2 (moderate, dev server accepts cross-origin requests) | `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild` | drizzle-kit only transpiles its config; esbuild's dev server is never started | Keep. npm's only "fix" downgrades `drizzle-kit` to 0.18 |

No `npm audit fix --force`. Re-check when `braces` or `drizzle-kit` publish fixes.

## Scripts

`dev`, `dev:worker`, `build`, `start`, `start:worker`, `lint`, `typecheck`, `test`.
The readiness test against a real database runs when `TEST_DATABASE_URL` is set (CI provides PostgreSQL 17).
