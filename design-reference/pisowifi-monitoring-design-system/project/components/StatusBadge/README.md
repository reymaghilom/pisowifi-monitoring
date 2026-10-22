Shows one machine or module state as a pill with an icon and a word.

Call `PisoWiFi.StatusBadge(key, label?)` and place the returned HTML where a status is needed. Provide only a known key. Do:
- Use `reachable`/`unreachable` only for the result of an HTTP check on the admin interface.
- Use `recent` for ZeroTier sightings, and show `inet` until internet verification actually exists.
- Use `soon` and `notconn` on any placeholder module; never show numbers next to them.
Don't: invent new colours for states or rely on colour alone.
