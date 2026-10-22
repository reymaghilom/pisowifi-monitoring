Static SVG line or area chart for uptime and response time.

Call `PisoWiFi.LineChart({labels, min, max, series})`; the consumer provides the data, axis range and unit. Use `l1` (solid) for PisoWiFi 01 and `l2` (dashed) for PisoWiFi 02, and add a legend and a `sample` badge on the card whenever values are invented. Set `min`/`max` tightly for uptime (for example 94–100%) so outages are visible.
