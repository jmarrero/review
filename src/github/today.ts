// Aggregate publication only: no discovery reads, links or write authority.
import { h } from "../dom.ts";
import { isObject } from "./heartbeat.ts";

export interface Today {
  schema: "agent-board/today/v1";
  day: string;
  observed_at: string;
  changes: { landed: number; closed: number; opened: number } | null;
  runs: { complete: boolean; by_kind: Record<string, number>; by_pool: Record<string, number> | null } | null;
  cost?: { day: string; complete: boolean; usd: number | null; priced_usd: number; unpriced_runs: number; unread_runs: number; weekly_budget_usd: number | null };
}

const DAY_MS = 86_400_000;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const previousDay = (v: string) => new Date(Date.parse(v) - DAY_MS).toISOString().slice(0, 10);

// Threat: arbitrary publisher inventories creating unbounded DOM. Bound both
// maps and their display names before rendering; names are text, not addresses.
function counters(v: unknown, limit: number, name: RegExp): boolean {
  return isObject(v) && Object.keys(v).length <= limit && Object.entries(v).every(([k, n]) => name.test(k) && count(n));
}

export function parseToday(raw: unknown): Today | string {
  const invalid = "Today unavailable: malformed, unsupported or over its publication bounds.";
  if (!isObject(raw) || raw.schema !== "agent-board/today/v1" || !day(raw.day)
    || typeof raw.observed_at !== "string" || raw.observed_at.length > 40
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(raw.observed_at)
    || !Number.isFinite(Date.parse(raw.observed_at)) || new Date(raw.observed_at).toISOString().slice(0, 10) !== raw.day) return invalid;
  const c = raw.changes, r = raw.runs, cost = raw.cost;
  if (c !== null && (!isObject(c) || ![c.landed, c.closed, c.opened].every(count))) return invalid;
  if (r !== null && (!isObject(r) || typeof r.complete !== "boolean"
    || !counters(r.by_kind, 32, /^[a-z][a-z -]{0,31}$/)
    || r.by_pool !== null && !counters(r.by_pool, 16, /^[A-Za-z0-9_.-]{1,64}$/))) return invalid;
  if (cost !== undefined && (!isObject(cost) || !day(cost.day) || cost.day !== previousDay(raw.day)
    || typeof cost.complete !== "boolean" || !money(cost.priced_usd) || !count(cost.unpriced_runs) || !count(cost.unread_runs)
    || cost.weekly_budget_usd !== null && (!money(cost.weekly_budget_usd) || cost.weekly_budget_usd === 0)
    || (cost.complete ? !money(cost.usd) || cost.usd !== cost.priced_usd || cost.unpriced_runs !== 0 || cost.unread_runs !== 0 : cost.usd !== null))) return invalid;
  return raw as unknown as Today;
}

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

export function todayView(data: Today | string | undefined, now: number, unavailable?: string): HTMLElement {
  const el = h("section", { class: "today", "aria-label": "Today" }, h("h2", {}, "Today"));
  if (unavailable) el.append(h("p", { class: "warn" }, `Today publication unavailable: ${unavailable}; any figures below are last read, not current.`));
  if (typeof data !== "object") {
    el.append(h("p", { class: "note" }, data ?? "Today not published (off, older producer or omitted); activity is unknown."));
    return el;
  }
  const age = now - Date.parse(data.observed_at);
  const stale = age > DAY_MS, future = age < 0, rollover = data.day !== new Date(now).toISOString().slice(0, 10);
  el.append(h("p", { class: stale || future || rollover ? "warn" : "note" },
    `${data.day} · since 00:00 UTC · observed ${data.observed_at}${stale ? " · stale (over a day old)" : future ? " · clock is in the future" : rollover ? " · previous UTC day, not today's activity" : ""}`));
  const grid = h("div", { class: "today-grid" });
  const changes = h("div", {}, h("h3", {}, "Board activity"));
  if (data.changes) {
    const stats = h("dl", { class: "today-counts" });
    for (const label of ["landed", "closed", "opened"] as const) stats.append(h("div", {}, h("dt", {}, label), h("dd", {}, String(data.changes[label]))));
    changes.append(stats);
  } else changes.append(h("p", { class: "note" }, "Changes unavailable; landed, closed and opened are unknown."));
  const runs = h("div", {}, h("h3", {}, "Observed starts"));
  if (data.runs) {
    runs.append(h("p", { class: data.runs.complete ? "note" : "warn" }, data.runs.complete ? "Published pass history carried whole; not all Actions runs." : "Incomplete pass history; counts are only observed starts, not all Actions runs."));
    for (const [label, counts] of [["By kind", data.runs.by_kind], ["By pool", data.runs.by_pool]] as const) {
      runs.append(h("p", {}, h("strong", {}, `${label}: `), counts === null ? "Unknown (not published)" : Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · ") || "No starts observed"));
    }
  } else runs.append(h("p", { class: "note" }, "Starts unavailable; kinds and pools are unknown."));
  grid.append(changes, runs);
  el.append(grid);
  if (data.cost) {
    const c = data.cost;
    el.append(h("p", { class: `today-cost ${c.complete ? "note" : "warn"}` }, h("strong", {}, `Cost · ${c.day} UTC: `),
      c.complete ? `${usd(c.usd!)} at list prices` : `Total unknown · ${usd(c.priced_usd)} priced subtotal · ${c.unpriced_runs} unpriced runs · ${c.unread_runs} unread runs`,
      c.weekly_budget_usd === null ? " · weekly budget not published" : ` · weekly budget ${usd(c.weekly_budget_usd)} (comparison, not remaining budget)`,
      ". Completed-day coverage; in-progress runs excluded."));
  }
  return el;
}
