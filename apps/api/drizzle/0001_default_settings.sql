-- Default workspace monitoring settings (single row, id = 1): check every 60 s, 5 s timeout, Stale after 3 misses.
INSERT INTO "monitoring_settings" ("id", "interval_seconds", "timeout_seconds", "stale_threshold")
VALUES (1, 60, 5, 3)
ON CONFLICT ("id") DO NOTHING;
