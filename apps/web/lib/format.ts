export const MIN = 60_000;
export const HR = 3_600_000;
export const DAY = 86_400_000;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function pad(n: number) {
  return (n < 10 ? "0" : "") + n;
}

/** "Oct 11" */
export function dShort(t: number) {
  const d = new Date(t);
  return MON[d.getMonth()] + " " + d.getDate();
}

/** "Oct 11, 14:05" */
export function dTime(t: number) {
  const d = new Date(t);
  return MON[d.getMonth()] + " " + d.getDate() + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/** "2026-10-11" (local date, for <input type="date">) */
export function iso(t: number) {
  const d = new Date(t);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** Relative time: "just now", "14 min ago", "3 h 5 min ago", "2 days ago", "Never". */
export function ago(t: number | null | undefined, now = Date.now()) {
  if (!t) return "Never";
  const d = Math.max(0, now - t);
  if (d < MIN) return "just now";
  if (d < HR) return Math.round(d / MIN) + " min ago";
  if (d < DAY) {
    const h = Math.floor(d / HR);
    const m = Math.round((d - h * HR) / MIN);
    return h + " h" + (m ? " " + m + " min" : "") + " ago";
  }
  const n = Math.round(d / DAY);
  return n + " day" + (n > 1 ? "s" : "") + " ago";
}

/** Duration from minutes: "45 min", "1 h 12 min". */
/** Date and time in the Philippines (Asia/Manila, UTC+8, no daylight saving), as used in alert emails. */
export function manilaTime(t: number) {
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }).format(t) + " (Asia/Manila, UTC+8)";
}

export function dur(min: number) {
  min = Math.round(min);
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + " h" + (m ? " " + m + " min" : "");
}

export function startDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
