/** The locale's time of day (12 or 24 h), or "" for an invalid timestamp. */
export function clock(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

/** An absolute timestamp for a relative time's tooltip. */
export function time(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? ""
    : d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

const AGE_UNITS: [number, string][] = [
  [7 * 24 * 3600_000, "w"],
  [24 * 3600_000, "d"],
  [3600_000, "h"],
  [60_000, "m"],
];

/** A compact age, e.g. "3d", or "" for no or a bad date. */
export function age(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t) || !Number.isFinite(now)) return "";
  const ms = Math.max(0, now - t);
  for (const [unit, suffix] of AGE_UNITS) if (ms >= unit) return `${Math.floor(ms / unit)}${suffix}`;
  return "now";
}

/** An age as a phrase, e.g. "3d ago" or "just now", or "" for no or a bad date. */
export function ago(iso: string | undefined, now: number): string {
  const text = age(iso, now);
  return text === "now" ? "just now" : text ? `${text} ago` : "";
}
