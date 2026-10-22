/* Who receives a status-change email. Resolved by the backend inside the transaction that records the change, and
   stored with the delivery, so every retry targets exactly the same people.
   Rule: every ACTIVE account (users.disabled_at is null), in sign-up order. An optional notification_prefs row can
   switch one kind off for that user (offline = false → no Offline alerts; recovery = false → no Back Online alerts);
   no row means both on. notification_prefs.email / telegram / quiet_hours are not consulted (nothing sets them yet;
   `email` defaults to false, which would silence everyone). No new columns or migration are needed. */
import { and, asc, isNull, sql } from "drizzle-orm";
import { NOTIFICATION_MAX_RECIPIENTS, type NotificationRecipient } from "@pisowifi/shared";
import { notificationPrefs, users } from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { StatusKind } from "./payload.js";

type Selectable = Pick<NonNullable<Db["orm"]>, "select">;

export async function notificationRecipients(q: Selectable, kind: StatusKind): Promise<NotificationRecipient[]> {
  const wanted = kind === "unreachable" ? notificationPrefs.offline : notificationPrefs.recovery;
  return q
    .select({ id: users.id, email: users.email })
    .from(users)
    .leftJoin(notificationPrefs, sql`${notificationPrefs.userId} = ${users.id}`)
    .where(and(isNull(users.disabledAt), sql`coalesce(${wanted}, true)`))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(NOTIFICATION_MAX_RECIPIENTS);
}
