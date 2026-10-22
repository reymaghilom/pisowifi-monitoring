# @pisowifi/shared

Types and Zod schemas shared by `apps/web` and `apps/api`, so both sides validate the same way and agree on
the API's request/response shapes. Pure TypeScript + Zod; no runtime dependencies on Node or the browser.

| Module | Contents |
| --- | --- |
| `machine.ts` | Machine statuses (`reachable \| stale \| unreachable \| unknown \| error`), ZeroTier state, internet state (`unverified` only), software types; field rules with the approved UI messages (`MACHINE_MESSAGES`); `machineInputSchema` (API body, with limits) including the optional backend-only `ztMemberId`; `machineSchema` (API representation with the four separate status signals); list query |
| `monitoring.ts` | Event types and event DTO, history ranges, series query, history point, monitoring settings (interval 30/60/300/900 s, timeout 1–30, stale threshold 1–10) |
| `auth.ts` | Roles (`admin`, `viewer`), login / password reset / profile / change-password contracts with the UI's messages, user and session DTOs |
| `api.ts` | Error envelope `{ error: { code, message, fields? } }` + `apiError()`, cursor pagination, list response, health/ready responses, `fieldErrors()` |

Notes:
- **ZeroTier Member ID** is optional in the backend contract (future discovery via the ZeroTier API). The Add/Edit
  form does not show it.
- The web form keeps its own field names; `apps/web/lib/validation.ts` adapts these schemas and adds the
  uniqueness checks that need the machine list. Messages must stay identical (covered by tests on both sides).
- Uniqueness of machine name and IP is not a schema rule: the API checks it against stored machines.

## Build

Compiled to `dist/` (ESM + type declarations). The root `postinstall` builds it, and the root `typecheck` and
`test` scripts rebuild it first. While editing: `npm run dev -w packages/shared` (tsc --watch).
