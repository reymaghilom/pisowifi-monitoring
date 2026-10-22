/* History retention and fixed-rate scheduling. Real migrations on PGlite. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { pruneChecks } from "../src/monitoring/retention.js";
import { nextDelayMs } from "../src/gateway/schedule.js";
import { loadConfig } from "../src/config/env.js";

const DAY = 86_400_000;
let pglite: PGlite;
let db: Db;
let machine: string;

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  machine = (await pglite.query<{ id: string }>("insert into machines (name, zt_ip) values ('PISOWIFI 1', '192.168.194.127') returning id")).rows[0]!.id;
});
afterAll(() => pglite.close());

const count = async () => (await pglite.query<{ n: number }>("select count(*)::int n from checks")).rows[0]!.n;

describe("pruneChecks", () => {
  it("deletes only checks older than the retention, in batches, and keeps events and outages", async () => {
    const now = Date.now();
    for (const ageDays of [200, 120, 95, 91, 89, 10, 0]) {
      await pglite.query("insert into checks (machine_id, started_at, ok, trigger) values ($1, $2, true, 'schedule')", [machine, new Date(now - ageDays * DAY).toISOString()]);
    }
    await pglite.query("insert into events (machine_id, type, status, message, occurred_at) values ($1, 'outage', 'unreachable', 'Became Unreachable', $2)", [machine, new Date(now - 200 * DAY).toISOString()]);
    await pglite.query("insert into outages (machine_id, started_at, ended_at) values ($1, $2, $3)", [machine, new Date(now - 200 * DAY).toISOString(), new Date(now - 199 * DAY).toISOString()]);

    expect(await pruneChecks(db, 90, { batch: 3 })).toBe(4); // two batches: 3 + 1
    expect(await count()).toBe(3);
    const left = (await pglite.query<{ age: number }>("select round(extract(epoch from now() - started_at) / 86400)::int age from checks order by started_at")).rows.map((r) => r.age);
    expect(left).toEqual([89, 10, 0]);
    expect((await pglite.query<{ n: number }>("select (select count(*) from events)::int + (select count(*) from outages)::int n")).rows[0]!.n).toBe(2);
    expect(await pruneChecks(db, 90)).toBe(0);
  });

  it("stops after the batch limit (the next hourly run continues)", async () => {
    for (let i = 0; i < 5; i++) await pglite.query("insert into checks (machine_id, started_at, ok, trigger) values ($1, $2, true, 'schedule')", [machine, new Date(Date.now() - (100 + i) * DAY).toISOString()]);
    expect(await pruneChecks(db, 90, { batch: 2, maxBatches: 1 })).toBe(2);
    expect(await pruneChecks(db, 90, { batch: 2 })).toBe(3);
  });

  it("is off unless configured, and refuses very short retention", () => {
    expect(loadConfig({ NODE_ENV: "test" }).CHECK_RETENTION_DAYS).toBeUndefined();
    expect(loadConfig({ NODE_ENV: "test", CHECK_RETENTION_DAYS: "90" }).CHECK_RETENTION_DAYS).toBe(90);
    expect(() => loadConfig({ NODE_ENV: "test", CHECK_RETENTION_DAYS: "3" })).toThrow();
  });
});

describe("nextDelayMs (fixed-rate scheduling)", () => {
  it("measures the interval from round start, so round time does not add up", () => {
    expect(nextDelayMs(0, 60, 5_000)).toBe(55_000);
    expect(nextDelayMs(0, 60, 0)).toBe(60_000);
  });
  it("keeps a short gap when a round overran the interval", () => {
    expect(nextDelayMs(0, 60, 75_000)).toBe(1000);
  });
});
