/* Drizzle schema (milestone B2). Migrations are generated from these files into apps/api/drizzle/.
   Approved decisions reflected here:
   - single workspace, roles admin | viewer (users.role)
   - machines.zt_member_id: optional, backend-only (not in the Add/Edit UI)
   - machine_state keeps four separate signals: Admin HTTP, ZeroTier, Internet verification, Monitoring health
   - session / reset tokens are stored only as SHA-256 digests */
export * from "./enums.js";
export * from "./auth.js";
export * from "./machines.js";
export * from "./monitoring.js";
export * from "./settings.js";
export * from "./notifications.js";
