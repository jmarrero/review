// The ops detail under the Agents section (devspaces, local agents,
// agent runs, active work and the bot's recent activity) and the Usage
// section's body. Times that move (uptime, time left) are marked so
// tickOps can update them in place every second without a re-render.

import { h, link, svg } from "../dom.ts";
import { type IssueRef, type Item, parseIssueUrl } from "./board.ts";
import { AGENT_WORKFLOW, BOT_LOGIN, DEVSPACE_REPO, DEVSPACE_WORKFLOW, HEARTBEAT_ISSUE, HEARTBEAT_STALE_MS, OPS_EVENTS_SHOWN, OPS_WINDOW_HOURS, TRACKER_REPO, USAGE_REPO } from "./config.ts";
import { type ControllerData, type PieceState, sessionPresent, schedulerPass, MAX_CONTROLLER_OUTPUT } from "./controller.ts";
import { PRESET_LABEL, PRESET_TITLE } from "./filter.ts";
import { type Heartbeat, isStale, type LocalWorker } from "./heartbeat.ts";
import {
  type AgentData,
  type AgentRun,
  type BotEvent,
  type Devspace,
  type DevspaceData,
  history,
  type Ops,
  type Outcome,
  type Phase,
  timeLeft,
  workGroups,
  type WorkGroup,
} from "./ops.ts";
import { type MistralBudget, type MistralUsage, poolPace, type RunUsage, spendByRun, type SpendTotal, type Tokens, tokenTotal, UNKNOWN_KIND, type Usage, type UsageData, type UsagePool, type UsageWindow } from "./usage.ts";
import { age, clock, pill, time } from "./view.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Classes and attributes tickOps finds its live times by. */
const TICK_SINCE = "tick-since";
const TICK_LEFT = "tick-left";
const TICK_BAR = "tick-bar";
const ATTR_T = "data-t";
const ATTR_MAX = "data-max";
const ATTR_TOTAL = "data-total";

/** "4m 05s" under an hour (with seconds, if asked), else "3h 07m". */
export function duration(ms: number, seconds = true): string {
  const s = Math.max(0, Math.floor(ms / SECOND));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hh > 0) return `${hh}h ${pad(mm)}m`;
  if (!seconds) return mm > 0 ? `${mm}m` : "<1m";
  return `${mm}m ${pad(s % 60)}s`;
}

/** The text of a time-left cell; "≤" when only the longest duration bounds it. */
export function leftText(ms: number, max: boolean): string {
  if (ms <= 0) return max ? "ending soon at the latest" : "ending now";
  return `${max ? "≤ " : ""}${duration(ms)} left`;
}

/** A token count: 950, 12k, 4.2M, 1.25B. */
export function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** Core-hours, to one decimal below 10. */
export function coreHoursText(n: number): string {
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

const clockAt = (iso: string | undefined): string => clock(Date.parse(iso ?? ""));

const PHASE_LABEL: Record<Phase, string> = { queued: "queued", starting: "starting", ready: "up", ending: "ending", done: "done" };
const PHASE_TITLE: Record<Phase, string> = {
  queued: "waiting for a runner",
  starting: "the runner is setting up; SSH isn't ready yet",
  ready: "reachable over SSH",
  ending: "its time is up or it was stopped; the runner is tearing down",
  done: "finished",
};
const OUTCOME_LABEL: Record<Outcome, string> = { stopped: "stopped", expired: "expired", failed: "failed", other: "other" };
const OUTCOME_TITLE: Record<Outcome, string> = {
  stopped: "cancelled: how bot-devspace stop ends a devspace, the normal case",
  expired: "ran out its duration",
  failed: "the run failed",
  other: "ended some other way",
};

/** A status dot with its word: never color alone. */
function status(cls: string, label: string, title: string): HTMLElement {
  return h("span", { class: `st ${cls}`, title }, h("span", { class: "dot", "aria-hidden": "true" }), label);
}

function sparkline(buckets: readonly number[], now: number): SVGSVGElement {
  const BAR = 4;
  const GAP = 1;
  const H = 28;
  const max = Math.max(...buckets, 0);
  const width = buckets.length * (BAR + GAP) - GAP;
  const el = svg("svg", { class: "spark", viewBox: `0 0 ${width} ${H}`, width: String(width * 1.5), height: String(H), role: "img", "aria-label": `core-hours per hour over the last ${buckets.length} hours` });
  buckets.forEach((v, i) => {
    const hgt = max > 0 && v > 0 ? Math.max(2, (v / max) * H) : 1;
    const from = new Date(now - (buckets.length - i) * HOUR);
    const label = `${clock(from.getTime())} · ${coreHoursText(v)} core-h`;
    el.append(svg("rect", { x: String(i * (BAR + GAP)), y: String(H - hgt), width: String(BAR), height: String(hgt), rx: "1", class: v > 0 ? "on" : "off" }, svg("title", {}, label)));
  });
  return el;
}

function tile(value: string, label: string, ...more: (Node | string | null)[]): HTMLElement {
  return h("div", { class: "tile" }, h("div", { class: "big" }, value), h("div", { class: "label" }, label), ...more);
}

function tiles(data: DevspaceData | undefined, now: number): HTMLElement | null {
  if (!data) return null;
  const live = data.devspaces.filter((d) => d.phase !== "done");
  const cores = live.reduce((n, d) => n + (d.cores ?? 0), 0);
  const hist = history(data.devspaces, now, OPS_WINDOW_HOURS);
  const o = hist.outcomes;
  const outcomes = [
    o.stopped ? `${o.stopped} stopped` : "",
    o.expired ? `${o.expired} expired` : "",
    o.other ? `${o.other} other` : "",
  ].filter(Boolean);
  return h(
    "div",
    { class: "tiles" },
    tile(String(live.length), live.length === 1 ? "devspace running" : "devspaces running", h("div", { class: "sub" }, cores ? `${cores} cores` : "no cores in use")),
    tile(
      coreHoursText(hist.coreHours),
      `core-hours, last ${OPS_WINDOW_HOURS}h`,
      sparkline(hist.buckets, now),
      hist.unsized ? h("div", { class: "sub" }, `${hist.unsized} of unknown size not counted`) : null,
    ),
    tile(
      `${hist.count}${data.partial ? "+" : ""}`,
      `devspaces started, last ${OPS_WINDOW_HOURS}h`,
      h(
        "div",
        { class: "sub" },
        o.failed ? h("span", { class: "bad" }, `${o.failed} failed`) : "none failed",
        outcomes.length ? ` · ${outcomes.join(" · ")}` : "",
      ),
    ),
  );
}

function section(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h("section", { class: "ops-sec" }, h("h2", {}, title), ...children);
}

function liveRow(d: Devspace, now: number): HTMLElement {
  const left = timeLeft(d, now);
  const since = Date.parse(d.startedAt ?? d.createdAt);
  const leftCell = left
    ? h(
        "span",
        { class: "left", title: left.bound === "max" ? "This run doesn't say its duration; this counts down the longest one devspace.yml allows." : `${d.durationMin} minutes asked for` },
        h("span", { class: TICK_LEFT, [ATTR_T]: String(now + left.ms), [ATTR_MAX]: left.bound === "max" ? "1" : "0" }, leftText(left.ms, left.bound === "max")),
        svg(
          "svg",
          { class: "bar", viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" },
          svg("rect", { class: "track", x: "0", y: "0", width: "100", height: "4", rx: "2" }),
          svg("rect", { class: TICK_BAR, x: "0", y: "0", width: String((left.ms / left.totalMs) * 100), height: "4", rx: "2", [ATTR_T]: String(now + left.ms), [ATTR_TOTAL]: String(left.totalMs) }),
        ),
      )
    : h("span", { class: "left" }, d.phase === "queued" ? "waiting for a runner" : "");
  return h(
    "div",
    { class: `ds-row p-${d.phase}` },
    status(`s-${d.phase}`, PHASE_LABEL[d.phase], PHASE_TITLE[d.phase]),
    h("div", { class: "who" }, h("strong", {}, d.name), h("code", { class: "host" }, d.host)),
    h("span", { class: "cores", title: "runner cores" }, d.cores ? `${d.cores}c` : "?c"),
    h(
      "span",
      { class: "up", title: `started ${time(d.startedAt ?? d.createdAt)}` },
      `${clockAt(d.startedAt ?? d.createdAt)} · up `,
      h("span", { class: TICK_SINCE, [ATTR_T]: String(since) }, duration(now - since)),
    ),
    leftCell,
    link(d.url, "run ↗"),
  );
}

function pastRow(d: Devspace, now: number): HTMLElement {
  const outcome = d.outcome ?? "other";
  const start = Date.parse(d.startedAt ?? "");
  const end = Date.parse(d.endedAt ?? "");
  const ran = Number.isNaN(start) || Number.isNaN(end) ? "" : duration(end - start, false);
  return h(
    "li",
    { class: "past" },
    status(`o-${outcome}`, OUTCOME_LABEL[outcome], `${OUTCOME_TITLE[outcome]}${d.conclusion ? ` (${d.conclusion})` : ""}`),
    h("span", { class: "name" }, d.name),
    h("span", { class: "cores" }, d.cores ? `${d.cores}c` : "?c"),
    h("span", { class: "ran", title: "time on the runner" }, ran),
    h("span", { class: "age", title: `ended ${time(d.endedAt)}` }, `${age(d.endedAt ?? d.createdAt, now)} ago`),
    link(d.url, "run ↗"),
  );
}

/** A section with no data: its read failed, or, in a cached copy, it isn't cached. */
function unavailable(fromCache: boolean): string {
  return fromCache ? "Not cached; loading…" : "Not available; see the warning above.";
}

function devspacesSection(data: DevspaceData | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Devspaces");
  if (!data) {
    sec.append(h("p", { class: "note" }, unavailable(fromCache)));
    return sec;
  }
  const live = data.devspaces.filter((d) => d.phase !== "done");
  if (live.length === 0) sec.append(h("p", { class: "note" }, "No devspace is running."));
  for (const d of live) sec.append(liveRow(d, now));
  const past = data.devspaces.filter((d) => d.phase === "done");
  if (past.length) {
    sec.append(
      h(
        "details",
        { class: "history" },
        h("summary", {}, `Finished in the last ${OPS_WINDOW_HOURS}h (${past.length}${data.partial ? ", maybe more" : ""})`),
        h("ul", { class: "past-list" }, ...past.map((d) => pastRow(d, now))),
      ),
    );
  }
  sec.append(h("p", { class: "fine" }, `Runs of ${DEVSPACE_REPO}'s ${DEVSPACE_WORKFLOW}; hosts are on the tailnet. Cancelled is how bot-devspace stop ends one, so it counts as stopped, not failed.`));
  return sec;
}

function agentRow(r: AgentRun, now: number): HTMLElement {
  const st = r.active
    ? status(`s-${r.status === "in_progress" ? "ready" : "queued"}`, r.status === "in_progress" ? "running" : r.status.replace(/_/g, " "), r.status)
    : status(`o-${r.outcome ?? "other"}`, r.conclusion ?? "done", r.conclusion ?? "");
  return h(
    "li",
    { class: "past" },
    st,
    h("span", { class: "name" }, link(r.url, r.title)),
    h("span", { class: "tag" }, r.actor ?? ""),
    h("span", { class: "age", title: `started ${time(r.startedAt)}` }, `${age(r.startedAt, now)} ago`),
  );
}

function agentsSection(data: AgentData | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Agent runs");
  if (!data) sec.append(h("p", { class: "note" }, unavailable(fromCache)));
  else if (!data.deployed) {
    sec.append(h("p", { class: "note" }, `Not deployed yet: ${DEVSPACE_REPO} has no ${AGENT_WORKFLOW} on its default branch. Runs show here once it lands.`));
  } else if (data.runs.length === 0) sec.append(h("p", { class: "note" }, "No agent runs yet."));
  else sec.append(h("ul", { class: "past-list" }, ...data.runs.map((r) => agentRow(r, now))));
  return sec;
}

/** A local worker's status as a dot: busy, starting or waiting. */
export function workerStatus(s: string): HTMLElement {
  const cls = s === "starting" ? "s-starting" : s === "waiting" ? "s-queued" : /^(working|testing|reviewing|landing)$/.test(s) ? "s-ready" : "s-unknown";
  return status(cls, s, `the worker's last reported status: ${s}`);
}

function localRow(w: LocalWorker, live: ReadonlySet<string>, now: number): HTMLElement {
  const since = Date.parse(w.startedAt);
  return h(
    "li",
    { class: "lw" },
    workerStatus(w.status),
    h("span", { class: "name" }, h("strong", {}, w.name), " ", link(w.itemUrl, w.itemRef)),
    h(
      "span",
      { class: "ds", title: w.devspace ? (live.has(w.devspace) ? "its devspace, running (above)" : "its devspace, not among the running ones") : "no devspace" },
      w.devspace ? `⌁ ${w.devspace}` : "",
    ),
    h("span", { class: "up", title: `started ${time(w.startedAt)}` }, h("span", { class: TICK_SINCE, [ATTR_T]: String(since) }, duration(now - since))),
  );
}

const LOOP_TITLE: Record<string, string> = {
  polling: "reading notifications, the inbox and the watch sweep",
  working: "acting on what it found: dispatching, reviewing, promoting",
  sleeping: "waiting for its next poll, or for a worker to finish",
  stopped: "the session ended",
};

function localSection(hb: Heartbeat | null | undefined, devspaces: DevspaceData | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Local agents");
  if (hb === undefined) {
    sec.append(h("p", { class: "note" }, unavailable(fromCache)));
    return sec;
  }
  if (hb === null) {
    sec.append(h("p", { class: "note" }, `No heartbeat published yet. The coordinator's workers run on its own machine, which this page can't see; they show here once it publishes them to ${TRACKER_REPO}#${HEARTBEAT_ISSUE}.`));
    return sec;
  }
  const stale = isStale(hb, now);
  const wake = hb.nextWakeAt && hb.loopState === "sleeping" && Date.parse(hb.nextWakeAt) > now ? ` · wakes at ${clockAt(hb.nextWakeAt)}` : "";
  sec.append(
    h(
      "p",
      { class: "coord" },
      "Coordinator ",
      h("code", { title: hb.session }, hb.session.slice(0, 8)),
      " ",
      h("span", { class: "loop", title: LOOP_TITLE[hb.loopState] ?? "" }, hb.loopState),
      ` · heartbeat ${age(hb.updatedAt, now)} ago${wake} · `,
      hb.commentUrl ? link(hb.commentUrl, "source ↗") : `${TRACKER_REPO}#${HEARTBEAT_ISSUE}`,
    ),
  );
  if (stale) {
    sec.append(h("p", { class: "warn" }, `Stale: no heartbeat since ${time(hb.updatedAt)} (${age(hb.updatedAt, now)} ago). The coordinator's session may have ended or be stuck, so this list may be out of date.`));
  }
  if (hb.workers.length === 0) sec.append(h("p", { class: "note" }, hb.loopState === "stopped" ? "The coordinator stopped." : "No local workers running."));
  else {
    const live = new Set((devspaces?.devspaces ?? []).filter((d) => d.phase !== "done").map((d) => d.name));
    sec.append(h("ul", { class: `past-list${stale ? " stale" : ""}` }, ...hb.workers.map((w) => localRow(w, live, now))));
  }
  if (hb.skipped) sec.append(h("p", { class: "fine" }, `${hb.skipped} malformed worker entr${hb.skipped === 1 ? "y" : "ies"} not shown.`));
  return sec;
}

const WINDOW_LABEL: Record<string, string> = { five_hour: "5-hour", seven_day: "7-day" };
/** Percent used from which a window's bar turns amber, then red. */
const PCT_WARN = 75;
const PCT_CRIT = 90;

const tokensTitle = (t: Tokens) =>
  `${tokensText(t.input)} input, ${tokensText(t.output)} output, ${tokensText(t.cacheRead)} cache read, ${tokensText(t.cacheWrite)} cache write`;

/** A reset time: the clock time, with the weekday if it isn't within a day. */
function resetText(iso: string, now: number): string {
  const t = Date.parse(iso);
  const d = new Date(t);
  const at = t - now < 20 * HOUR ? clock(t) : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return t > now ? `resets ${at}, in ${duration(t - now, false)}` : `reset at ${at}; the percent is from before`;
}

function windowRow(w: UsageWindow, now: number): HTMLElement {
  const label = WINDOW_LABEL[w.kind] ?? w.kind.replace(/_/g, " ");
  const tokens = h("span", { class: "tok", title: `since ${time(w.since)}: ${tokensTitle(w.tokens)}, in ${w.requests} requests` }, `${tokensText(tokenTotal(w.tokens))} tokens · ${tokensText(w.tokens.output)} out`);
  if (w.usedPercent === undefined || !w.resetsAt) {
    return h(
      "div",
      { class: "uw" },
      h("span", { class: "wl" }, label),
      h("span", { class: "pct unknown", title: "The status line hasn't reported this window; see bot-heartbeat statusline." }, "—"),
      h("span", { class: "reset" }, `since ${clockAt(w.since)}`),
      tokens,
    );
  }
  const pct = w.usedPercent;
  const level = pct >= PCT_CRIT ? "crit" : pct >= PCT_WARN ? "warn" : "ok";
  const past = Date.parse(w.resetsAt) <= now;
  return h(
    "div",
    { class: `uw u-${level}${past ? " past-reset" : ""}` },
    h("span", { class: "wl" }, label),
    h(
      "span",
      { class: "pct" },
      h("span", { class: "num" }, `${pct % 1 ? pct.toFixed(1) : String(pct)}%`),
      svg(
        "svg",
        { class: "bar", viewBox: "0 0 100 6", preserveAspectRatio: "none", role: "img", "aria-label": `${label} window: ${pct}% used` },
        svg("rect", { class: "track", x: "0", y: "0", width: "100", height: "6", rx: "3" }),
        svg("rect", { class: "fill", x: "0", y: "0", width: String(Math.min(100, pct)), height: "6", rx: "3" }),
      ),
    ),
    h("span", { class: "reset", title: time(w.resetsAt) }, resetText(w.resetsAt, now)),
    tokens,
  );
}

interface Consumer {
  label: Node | string;
  tokens: Tokens;
}

/** The subscription pools of bot-usage/v1, in the order shown. */
const POOLS = [["claude", "Claude"], ["openai", "OpenAI"]] as const;
/** Names a pool's expander, so a redraw can keep it open. */
export const POOL_ATTR = "data-pool";
/** The pool bar's box: a 6-unit track with the pace tick standing 2 units proud of it on each side. */
const POOL_BAR = { width: 100, height: 10, track: 6, tick: 1 };

/** A pool's label and sentence: the percent used, the share of the window gone, and the projection to its end. */
export function poolWords(pool: UsagePool): { short: string; long: string } {
  const pace = poolPace(pool);
  const projected = pace.projectedPercent === undefined ? "" : ` · ~${Math.round(pace.projectedPercent)}% at reset`;
  return {
    short: `${Math.round(pool.usedPercent)}% used · ${Math.round(pace.gonePercent)}% of ${pace.unit} gone${projected}`,
    long: `${pool.usedPercent.toFixed(1)}% used with ${pace.gonePercent.toFixed(1)}% of the ${pace.unit} gone${pace.projectedPercent === undefined ? " (too early to project)" : `, so ~${pace.projectedPercent.toFixed(0)}% by its end at this rate`}`,
  };
}

/** A reading older than this is stale: the usage publisher has not reported since. */
export const poolStale = (pool: UsagePool, now: number): boolean => now - Date.parse(pool.observedAt) > HEARTBEAT_STALE_MS;

/**
 * What a bare "held" and "stale" left to be guessed: that the scheduler
 * starts no new work on the pool (running work goes on), until when if
 * the snapshot said, and how old a stale reading is. "" for neither.
 */
export function poolStateWords(pool: UsagePool, now: number): { held: string; stale: string } {
  // A time already past (a reading from before it, not since updated) is no end to promise.
  const next = pool.nextDispatchAt && (Date.parse(pool.nextDispatchAt) > now ? ` until ${time(pool.nextDispatchAt)}` : ` (was due to end ${time(pool.nextDispatchAt)})`);
  return {
    held: !pool.hold ? "" : ` · new work held${next || ""}`,
    stale: poolStale(pool, now) ? ` · stale: read ${duration(now - Date.parse(pool.observedAt), false)} ago` : "",
  };
}

/**
 * One pool as a compact row: its name, a thin bar of the percent used
 * with a tick at what the scheduler allows by now, and a short label of
 * the percent used against the share of the window gone. The sentence it
 * replaces (exact percents, reset, observation time) is in its expander.
 */
function poolRow(name: string, label: string, pool: UsagePool | undefined, now: number, snapshotAt: string): HTMLElement {
  if (!pool) return h("div", { class: "pool-sum none" }, h("span", { class: "pool-name" }, label), " ", h("span", { class: "pool-label" }, `No reading · ${snapshotAt ? `snapshot ${age(snapshotAt, now)} ago` : "snapshot age unknown"}.`));
  const used = pool.usedPercent.toFixed(1);
  const allowed = pool.allowedPercent.toFixed(1);
  const over = pool.usedPercent > pool.allowedPercent;
  const stale = poolStale(pool, now);
  const state = poolStateWords(pool, now);
  const flags = `${over ? " · over pace" : ""}${state.held}`;
  const words = poolWords(pool);
  const clamp = (n: number, max: number) => String(Math.max(0, Math.min(max, n)));
  const y = String((POOL_BAR.height - POOL_BAR.track) / 2);
  const track = { x: "0", y, height: String(POOL_BAR.track), rx: String(POOL_BAR.track / 2) };
  const bar = svg(
    "svg",
    {
      class: "bar",
      viewBox: `0 0 ${POOL_BAR.width} ${POOL_BAR.height}`,
      preserveAspectRatio: "none",
      role: "progressbar",
      "aria-label": `${label} weekly usage`,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": clamp(pool.usedPercent, 100),
      "aria-valuetext": `${used}% used, ${allowed}% allowed by pace${flags.replaceAll(" ·", ",")}${stale ? ", stale" : ""}`,
    },
    svg("rect", { class: "track", ...track, width: String(POOL_BAR.width) }),
    svg("rect", { class: "fill", ...track, width: clamp(pool.usedPercent, POOL_BAR.width) }),
    svg("rect", { class: "tick", x: clamp(pool.allowedPercent - POOL_BAR.tick / 2, POOL_BAR.width - POOL_BAR.tick), y: "0", width: String(POOL_BAR.tick), height: String(POOL_BAR.height) }),
  );
  return h(
    "details",
    { class: `pool${pool.hold || over ? " over" : ""}`, [POOL_ATTR]: name },
    h(
      "summary",
      { class: "pool-sum" },
      h("span", { class: "pool-name" }, label),
      " ",
      bar,
      h("span", { class: "pool-label" }, words.short, state.held, stale && h("span", { class: "pool-stale" }, state.stale)),
    ),
    h(
      "div",
      { class: "pool-detail" },
      h("p", {}, `${words.long}. The tick is what the scheduler allows by now: ${allowed}%${flags}.`),
      h("p", {}, `${resetText(pool.resetsAt, now)} (${time(pool.resetsAt)}).`),
      // The snapshot is the Usage workflow's (see the controller panel): stale means it has not published since.
      h("p", {}, `Observed ${time(pool.observedAt)}${stale ? `, ${duration(now - Date.parse(pool.observedAt), false)} ago · stale: the usage publisher has not reported since` : ""}.`),
    ),
  );
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The time to a monthly reset: days while more than one is left, or that it passed. */
function monthLeft(iso: string, now: number): string {
  const t = Date.parse(iso);
  const days = Math.floor((t - now) / (24 * HOUR));
  return t <= now ? "reset passed" : `resets in ${days > 1 ? `${days} days` : duration(t - now, false)}`;
}

/** A monthly reset: its date and the time to it. The date is UTC's, as billing months are: a reset at midnight UTC is on the 1st, not the 31st before it. */
function monthResetText(iso: string, now: number): string {
  const date = `${new Date(Date.parse(iso)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} UTC`;
  return Date.parse(iso) <= now ? `reset ${date}; the spend is from before` : `${monthLeft(iso, now)}, on ${date}`;
}

/**
 * Mistral's row: with an allowance, a bar of the month's spend against
 * it (no pace tick: the broker reports no window start), marked as an
 * estimate when it was worked out from tokens and prices; without one,
 * the broker's counters since it started.
 */
function mistralRow(m: MistralUsage, now: number): HTMLElement {
  const n = (v: number) => v.toLocaleString("en-US");
  const counters = `${n(m.requests)} requests · ${n(m.tokens)} tokens since the broker started`;
  const a = m.allowance;
  if (!a && m.budget) return budgetRow(m, m.budget, counters, now);
  if (!a) return h("div", { class: "pool-sum mistral none" }, h("span", { class: "pool-name" }, "Mistral"), " ", h("span", { class: "pool-label" }, counters));
  const pct = (100 * a.spentUsd) / a.limitUsd;
  // An estimate that left models out is a lower bound.
  const spent = `${a.estimated ? (a.lowerBound ? "≥ ~" : "~") : ""}${usd(a.spentUsd)}`;
  const est = a.estimated ? " (estimate)" : "";
  const clamp = (v: number) => String(Math.max(0, Math.min(POOL_BAR.width, v)));
  const y = String((POOL_BAR.height - POOL_BAR.track) / 2);
  const track = { x: "0", y, height: String(POOL_BAR.track), rx: String(POOL_BAR.track / 2) };
  const bar = svg(
    "svg",
    {
      class: "bar",
      viewBox: `0 0 ${POOL_BAR.width} ${POOL_BAR.height}`,
      preserveAspectRatio: "none",
      role: "progressbar",
      "aria-label": "Mistral monthly allowance",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": clamp(pct),
      "aria-valuetext": `${spent} of ${usd(a.limitUsd)} spent${est}`,
    },
    svg("rect", { class: "track", ...track, width: String(POOL_BAR.width) }),
    svg("rect", { class: "fill", ...track, width: clamp(pct) }),
  );
  return h(
    "details",
    { class: `pool mistral${pct >= 100 ? " over" : ""}`, [POOL_ATTR]: "mistral" },
    // Short, like the pools' labels, so the bar keeps its room on a phone; the sentence is in the detail.
    h("summary", { class: "pool-sum" }, h("span", { class: "pool-name" }, "Mistral"), " ", bar, h("span", { class: "pool-label" }, `${spent} / ${usd(a.limitUsd).replace(/\.00$/, "")}${a.estimated ? " est." : ""} · ${monthLeft(a.resetsAt, now).replace(/^resets in (\d+) days$/, "$1d left")}`)),
    h(
      "div",
      { class: "pool-detail" },
      h("p", {}, `${spent} of the ${usd(a.limitUsd)} monthly allowance${est} · ${monthResetText(a.resetsAt, now)} (${time(a.resetsAt)})`),
      a.estimated && h("p", {}, `Estimated from this month's tokens and the published prices, not Mistral's own figure.${a.unpriced.length ? ` No price for ${a.unpriced.join(", ")}.` : ""}${a.lowerBound ? " Some models were left out, so the spend is at least this." : ""}`),
      h("p", {}, `${counters}.`),
    ),
  );
}

/** The share of a calendar month gone. */
export function monthGone(budget: MistralBudget, now: number): number {
  const since = Date.parse(budget.since);
  return Math.max(0, Math.min(100, (100 * (now - since)) / (Date.parse(budget.resetsAt) - since)));
}

/**
 * Mistral against the allowance in the pools file, when the snapshot
 * has none: the allowance and the share of the month gone, as a tick on
 * an empty bar. The broker publishes no spend, and its counters run from
 * its own start, not the month's, so no spend is made up from them.
 */
function budgetRow(m: MistralUsage, b: MistralBudget, counters: string, now: number): HTMLElement {
  const gone = monthGone(b, now);
  const limit = usd(b.limitUsd).replace(/\.00$/, "");
  const y = String((POOL_BAR.height - POOL_BAR.track) / 2);
  const track = { x: "0", y, height: String(POOL_BAR.track), rx: String(POOL_BAR.track / 2) };
  const bar = svg(
    "svg",
    { class: "bar", viewBox: `0 0 ${POOL_BAR.width} ${POOL_BAR.height}`, preserveAspectRatio: "none", role: "img", "aria-label": `Mistral: ${limit} a month, spend not published, ${Math.round(gone)}% of the month gone` },
    svg("rect", { class: "track", ...track, width: String(POOL_BAR.width) }),
    svg("rect", { class: "tick", x: String(Math.max(0, Math.min(POOL_BAR.width - POOL_BAR.tick, gone - POOL_BAR.tick / 2))), y: "0", width: String(POOL_BAR.tick), height: String(POOL_BAR.height) }),
  );
  return h(
    "details",
    { class: "pool mistral", [POOL_ATTR]: "mistral" },
    h("summary", { class: "pool-sum" }, h("span", { class: "pool-name" }, "Mistral"), " ", bar, h("span", { class: "pool-label" }, `spend ? / ${limit} · ${Math.round(gone)}% of month gone`)),
    h(
      "div",
      { class: "pool-detail" },
      h("p", {}, `${usd(b.limitUsd)} a calendar month, ${Math.round(gone)}% of it gone · ${monthResetText(b.resetsAt, now)}. `, b.url ? link(b.url, "Allowance ↗") : ""),
      h("p", {}, "The snapshot has no spend: it needs mistral.allowance with spent_usd, or this month's models and prices, from the publisher."),
      h("p", {}, `${counters}.`),
    ),
  );
}

/** Weekly pace uses the subscription's seven days, not the transcript accounting start. */
export function weeklyUsage(data: UsageData | undefined, now: number): HTMLElement {
  const sec = h("div", {}, h("h2", {}, "Weekly subscription usage"));
  if (!data || data.state !== "ok") {
    sec.append(h("p", { class: "note" }, !data ? "Reading usage…" : data.state === "unreadable" ? `Usage unavailable: this token cannot read ${USAGE_REPO}.` : "No usage published yet."));
    return sec;
  }
  const usage = data.usage;
  if (usage.pools) {
    sec.append(
      h(
        "div",
        { class: "pools" },
        ...POOLS.map(([name, label]) => poolRow(name, label, usage.pools?.[name], now, usage.updatedAt || usage.observedAt || "")),
        ...(usage.mistral ? [mistralRow(usage.mistral, now)] : []),
        h("p", { class: "fine" }, usage.updatedAt ? `Published ${time(usage.updatedAt)}. ` : "Publication time unknown. ", usage.commentUrl ? link(usage.commentUrl, "Source ↗") : ""),
      ),
      spendRows(usage, now),
    );
    return sec;
  }
  const weekly = usage.windows.find((w) => w.kind === "seven_day");
  sec.append(h("h3", {}, "Claude"));
  if (weekly) {
    sec.append(windowRow(weekly, now));
    if (weekly.usedPercent !== undefined && weekly.resetsAt && Date.parse(weekly.resetsAt) > now) {
      const pace = Math.max(0, Math.min(100, 100 * (1 - (Date.parse(weekly.resetsAt) - now) / (7 * 24 * HOUR))));
      const delta = weekly.usedPercent - pace;
      sec.append(h("p", { class: "note" }, `${pace.toFixed(1)}% of weekly time elapsed · ${Math.abs(delta).toFixed(1)} percentage points ${delta > 0 ? "ahead of" : "below"} pace.`));
    }
  } else sec.append(h("p", { class: "note" }, "Weekly usage not reported."));
  sec.append(h("h3", {}, "OpenAI"), h("p", { class: "note" }, "Weekly usage not reported in the available bot-usage/v1 data."));
  const observed = usage.observedAt;
  sec.append(h("p", { class: observed && now - Date.parse(observed) <= HEARTBEAT_STALE_MS ? "fine" : "warn" }, observed ? `Observed ${time(observed)}${now - Date.parse(observed) > HEARTBEAT_STALE_MS ? " · stale" : ""}.` : "Observation time unknown; publication does not confirm a fresh subscription reading.", ` Published ${time(usage.updatedAt)}.`, usage.commentUrl ? link(usage.commentUrl, "Source ↗") : ""));
  return sec;
}

/** A pool's label in the run table: the meter's name for the ones it shows, the snapshot's word for a newer one. */
const POOL_LABEL = new Map<string, string>([...POOLS, ["mistral", "Mistral"]]);

/** "implement 12.3M (3 runs) · review 4.1M (1 run)": a total's name, tokens and run count. */
function totalsText(totals: readonly SpendTotal[]): string {
  return totals.map((t) => `${t.name} ${tokensText(t.tokens)} (${t.runs} ${t.runs === 1 ? "run" : "runs"})`).join(" · ");
}

function runRow(r: RunUsage): HTMLElement {
  // Both links are built from parts the parser matched, never from a URL the snapshot gave.
  const item = r.item ? /^([^#]+)#(\d+)$/.exec(r.item) : null;
  const requests = r.requests === undefined ? "" : `, in ${r.requests} ${r.requests === 1 ? "request" : "requests"}`;
  return h(
    "tr",
    {},
    h("td", {}, POOL_LABEL.get(r.pool) ?? r.pool),
    h("td", r.kind ? {} : { class: "unknown" }, r.kind ?? UNKNOWN_KIND),
    h("td", {}, r.repository),
    h("td", {}, item ? link(`https://github.com/${item[1]}/issues/${item[2]}`, r.item ?? "") : h("span", { class: "unknown" }, "—")),
    h("td", { class: "num", title: `${tokensTitle(r.tokens)}${requests}` }, tokensText(tokenTotal(r.tokens))),
    h("td", { class: "when" }, link(`https://github.com/${r.repository}/actions/runs/${r.runId}`, time(r.finishedAt))),
  );
}

/**
 * Where the day's spend went, run by run, largest first, with totals by
 * kind and by repository; or one line on why the snapshot can't say.
 */
function spendRows(usage: Usage, now: number): HTMLElement {
  const box = h("div", { class: "spend" }, h("h3", { class: "group-h" }, "By run, last day"));
  if (!usage.runs) {
    box.append(h("p", { class: "fine" }, "Not published: the snapshot carries no runs list, so nothing says which runs spent it (see the README)."));
    return box;
  }
  const spend = spendByRun(usage.runs, now);
  if (!spend.runs.length) {
    box.append(h("p", { class: "fine" }, "No run finished in the last day."));
    return box;
  }
  box.append(
    h(
      "table",
      { class: "spend-runs" },
      h("thead", {}, h("tr", {}, h("th", {}, "Pool"), h("th", {}, "Kind"), h("th", {}, "Repository"), h("th", {}, "Item"), h("th", { class: "num" }, "Tokens"), h("th", {}, "Finished"))),
      h("tbody", {}, ...spend.runs.map(runRow)),
    ),
    h("p", { class: "fine" }, "By kind: ", totalsText(spend.byKind), "."),
    h("p", { class: "fine" }, "By repository: ", totalsText(spend.byRepository), "."),
    h("p", { class: "fine" }, "Tokens: the broker's per-run record, cache reads included; a row links to its run."),
  );
  return box;
}

function consumerRow(c: Consumer, max: number): HTMLElement {
  const n = tokenTotal(c.tokens);
  return h(
    "li",
    { class: "uc" },
    h("span", { class: "name" }, c.label),
    svg(
      "svg",
      { class: "bar", viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" },
      svg("rect", { class: "fill", x: "0", y: "0", width: String(max > 0 ? (n / max) * 100 : 0), height: "4", rx: "2" }),
    ),
    h("span", { class: "tok", title: tokensTitle(c.tokens) }, tokensText(n)),
  );
}

/**
 * The plan's usage: a bar per window, and who spent the most, their
 * items linked from the heartbeat's workers. Null when there is nothing
 * to say (not read yet, or its read failed: see the warnings).
 */
export function usageSection(data: UsageData | undefined, hb: Heartbeat | null | undefined, now: number): HTMLElement | null {
  if (!data) return null;
  const sec = h("div", { class: "usage-body" });
  if (data.state === "unreadable") {
    sec.append(h("p", { class: "note" }, `Private: it's in ${USAGE_REPO}, which this token can't read.`));
    return sec;
  }
  if (data.state === "none") {
    sec.append(h("p", { class: "note" }, `No usage published to ${USAGE_REPO} yet.`));
    return sec;
  }
  const usage = data.usage;
  // Published with the heartbeat but in a comment of its own: stale with
  // it, or when it fell behind it (its publishing failed); with no
  // heartbeat, by its own age.
  if (!usage.windows.length && usage.pools) return weeklyUsage(data, now);
  const behind = (since: number) => !usage.updatedAt || since - Date.parse(usage.updatedAt) > HEARTBEAT_STALE_MS;
  const stale = hb ? isStale(hb, now) || behind(Date.parse(hb.updatedAt)) : behind(now);
  sec.append(h("div", { class: `uw-list${stale ? " stale" : ""}` }, ...usage.windows.map((w) => windowRow(w, now))));
  const listed = new Map((hb?.workers ?? []).map((w) => [w.name, w]));
  const consumers: Consumer[] = usage.workers.map((w) => {
    const lw = listed.get(w.name);
    return { label: h("span", {}, h("strong", {}, w.name), ...(lw ? [" ", link(lw.itemUrl, lw.itemRef)] : [])), tokens: w.tokens };
  });
  if (usage.coordinatorTokens) consumers.push({ label: h("span", { title: "the coordinator's own session, in the 5-hour window" }, h("strong", {}, "coordinator"), " (5-hour window)"), tokens: usage.coordinatorTokens });
  consumers.sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));
  if (consumers.length) {
    const max = consumers[0] ? tokenTotal(consumers[0].tokens) : 0;
    sec.append(h("h3", { class: "group-h" }, "Consumers"), h("ul", { class: `uc-list${stale ? " stale" : ""}` }, ...consumers.map((c) => consumerRow(c, max))));
  }
  sec.append(
    h(
      "p",
      { class: "fine" },
      usage.observedAt ? `Percent used: Claude Code's status line on the coordinator's machine, as of ${time(usage.observedAt)}. ` : "Percent used: not reported yet; it comes from the coordinator's status line (bot-heartbeat statusline). ",
      "Tokens: that machine's transcripts, cache reads included; a worker's are all of its subagents'. ",
      usage.updatedAt ? `Published at ${time(usage.updatedAt)} to ` : "Publication time unknown; source: ",
      usage.commentUrl ? link(usage.commentUrl, USAGE_REPO) : USAGE_REPO,
      ", private.",
    ),
  );
  return sec;
}

/** A finished run's conclusion as a dot; cancelled is how a newer pass replaces one, so not a failure. */
function conclusionStatus(c: string | undefined): HTMLElement {
  if (c === "success") return status("c-ok", "ok", "the last run succeeded");
  if (c === "cancelled" || c === "skipped") return status("o-stopped", c, "the last run was cancelled or skipped");
  if (c === "failure" || c === "timed_out" || c === "startup_failure") return status("o-failed", c.replace(/_/g, " "), "the last run failed");
  return status("o-other", c ?? "done", c ?? "");
}

/** A queued or stuck successor must not make an old completed pass look fresh. */
function updatePassAge(el: Element, now: number): void {
  const at = Date.parse(el.getAttribute(ATTR_T) ?? "");
  const minutes = Math.max(0, Math.floor((now - at) / MINUTE));
  const stale = !Number.isFinite(at) || at > now || now - at > Number(el.getAttribute("data-stale-ms"));
  el.textContent = Number.isFinite(at) && at <= now ? `last pass ${minutes} minutes ago${stale ? " · stale" : ""}` : "last pass time unknown · stale";
  el.classList.toggle("warn", stale);
}

function pieceRow(p: PieceState, now: number): HTMLElement {
  const { piece } = p;
  const name = h("span", { class: "name" }, h("strong", {}, piece.label), " ", h("span", { class: "what" }, piece.what));
  if (p.state === "absent") return h("li", { class: "ctl" }, status("s-unknown", "not built", `${piece.repo} has no runs of ${piece.workflow}${piece.job ? `'s ${piece.job} job` : ""} yet`), name);
  if (p.state === "unseen") return h("li", { class: "ctl" }, status("s-unknown", "not seen", `its ${piece.job} job isn't in the last runs of ${piece.workflow}: not built yet, or skipped`), name);
  if (p.state === "uncached") return h("li", { class: "ctl" }, status("s-unknown", "…", "not cached; loading"), name, h("span", { class: "when" }, "loading…"));
  if (p.state === "error") return h("li", { class: "ctl" }, status("o-failed", "unread", p.error ?? ""), name, h("span", { class: "when" }, "couldn't read its runs"));
  const st = p.last ? conclusionStatus(p.last.conclusion) : p.running ? status("s-ready", "running", "running, none finished yet") : status("s-unknown", "no run", "");
  let lastPass: Node | undefined;
  if (piece.staleAfterMinutes !== undefined && p.last) {
    const passAge = h("span", { class: "ctl-pass-age", [ATTR_T]: p.last.at, "data-stale-ms": String(piece.staleAfterMinutes * MINUTE), title: `finished ${time(p.last.at)}; stale after ${piece.staleAfterMinutes} minutes` });
    updatePassAge(passAge, now);
    lastPass = link(p.last.url, "");
    lastPass.appendChild(passAge);
  }
  const li = h(
    "li",
    { class: "ctl" },
    st,
    name,
    h(
      "span",
      { class: "when" },
      lastPass ?? (p.last ? h("span", { title: `finished ${time(p.last.at)}` }, `${age(p.last.at, now)} ago `) : ""),
      lastPass ? "" : p.last ? link(p.last.url, "run ↗") : piece.staleAfterMinutes !== undefined ? h("span", { class: "warn" }, "No completed pass") : "",
      p.running ? h("span", { class: "now", title: `started ${time(p.running.at)}` }, p.last ? " · " : "", link(p.running.url, `${p.running.status && p.running.status !== "in_progress" ? p.running.status.replace(/_/g, " ") : "running"} now ↗`)) : "",
    ),
  );
  if (piece.read === "scheduler") {
    const detail = h("div", { class: "detail" });
    const show = (pass: ReturnType<typeof schedulerPass>) => {
      detail.replaceChildren();
      detail.append(h("span", {}, pass.mode === "unknown" ? "unknown · see the job's log " : `${pass.mode} · ${pass.liveEpics} live epics · ${pass.candidates} candidates · ${pass.mode === "preview" ? "would start" : "started"} ${pass.partial ? `at least ${pass.starts} (only ${pass.items!.length} of ${pass.candidates} items published)` : pass.starts}`));
      if (pass.mode === "unknown" && p.last) detail.append(link(p.last.url, "↗"));
      if (pass.raw) detail.append(h("pre", {}, pass.raw));
      for (const line of [...(pass.items ?? []), ...(pass.census ?? [])]) detail.append(h("div", {}, line));
    };
    show(p.scheduler ?? { mode: "unknown" });
    // Read whole from the job's notices: nothing to paste.
    if (p.scheduler && p.scheduler.mode !== "unknown" && !p.scheduler.partial) li.append(detail);
    else {
      // Do not set maxlength: browsers truncate an oversized paste before
      // input, which could turn a partial log into a false "started 0".
      const input = h("textarea", { "aria-label": "Scheduler and census output", rows: "4" }) as HTMLTextAreaElement;
      input.addEventListener("input", () => show(schedulerPass(input.value)));
      li.append(h("div", { class: "ctl-output", "data-run": p.last ? `${piece.repo}/${piece.workflow}/${piece.job}/${p.last.url}/${p.last.at}` : "" }, detail, h("details", {}, h("summary", {}, "Read pasted job output"), h("p", {}, `Paste up to ${MAX_CONTROLLER_OUTPUT / 1024} KiB of the linked job's scheduler and epic census output. This stays in this panel; GitHub summaries have no API and log redirects are blocked by this app's token boundary.`), input)));
    }
  }
  if (p.inFlight) {
    li.append(
      p.inFlight.length
        ? h("ul", { class: "detail flight" }, ...p.inFlight.map((r) => h("li", {}, link(r.url, r.title), h("span", { class: "age", title: `started ${time(r.since)}` }, ` ${r.status === "in_progress" ? "" : `${r.status.replace(/_/g, " ")} · `}${age(r.since, now)}`))))
        : h("span", { class: "detail" }, "none in flight"),
    );
  }
  return li;
}

/**
 * What runs hosted and whether the interactive session is there: the
 * operator can tell whether shutting the session down would stop
 * anything. The session counts only while its heartbeat is fresh.
 */
function controllerSection(data: ControllerData | undefined, hb: Heartbeat | null | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Controller");
  if (!data) sec.append(h("p", { class: "note" }, unavailable(fromCache)));
  else if (data.pieces.length) sec.append(h("h3", { class: "group-h" }, "Hosted"), h("ul", { class: "ctl-list" }, ...data.pieces.map((p) => pieceRow(p, now))));
  sec.append(h("h3", { class: "group-h" }, "Interactive"));
  if (hb === undefined) {
    sec.append(h("p", { class: "ctl-session" }, status("s-unknown", "unknown", "the heartbeat wasn't read"), " Heartbeat not read, so whether a session is there is unknown."));
  } else if (hb && sessionPresent(hb, now)) {
    sec.append(h("p", { class: "ctl-session" }, status("s-ready", "present", "its heartbeat is fresh"), " Controller chat · heartbeat ", `${age(hb.updatedAt, now)} ago · `, hb.commentUrl ? link(hb.commentUrl, "source ↗") : `${TRACKER_REPO}#${HEARTBEAT_ISSUE}`));
  } else {
    sec.append(
      h(
        "p",
        { class: "ctl-session none" },
        status("s-unknown", "absent", hb ? `last heartbeat ${time(hb.updatedAt)}` : "no heartbeat read"),
        " No interactive session: new work starts only from the board scheduler.",
        hb ? h("span", { class: "fine" }, ` Last heartbeat ${age(hb.updatedAt, now)} ago${hb.loopState === "stopped" ? ", stopped" : ""}.`) : "",
      ),
    );
  }
  return sec;
}

function refLabel(url: string): string {
  const ref: IssueRef | undefined = parseIssueUrl(url);
  if (ref) return `${ref.owner}/${ref.repo}#${ref.number}`;
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return url;
  }
}

function workItem(item: Item, now: number): HTMLElement {
  return h(
    "li",
    { class: "work" },
    h(
      "div",
      { class: "hdr" },
      pill(item.priority),
      h("span", { class: "title" }, item.url ? link(item.url, item.title) : item.title),
      h("span", { class: "age", title: `updated ${time(item.updatedAt)}` }, item.updatedAt ? `${age(item.updatedAt, now)} ago` : ""),
    ),
    item.branch.length ? h("div", { class: "links" }, ...item.branch.map((u) => link(u, refLabel(u)))) : null,
    item.why ? h("p", { class: "why" }, item.why) : null,
  );
}

const GROUP_LABEL: Record<WorkGroup["scope"], [string, string]> = {
  composefs: [PRESET_LABEL.composefs, PRESET_TITLE.composefs],
  infra: [PRESET_LABEL.infra, PRESET_TITLE.infra],
  none: ["No org", "items with no target organization"],
};

function workSection(items: Item[] | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Active work");
  if (!items) {
    sec.append(h("p", { class: "note" }, unavailable(fromCache)));
    return sec;
  }
  const groups = workGroups(items);
  if (groups.length === 0) sec.append(h("p", { class: "note" }, "Nothing is In Progress on the board."));
  for (const g of groups) {
    const [label, title] = GROUP_LABEL[g.scope];
    sec.append(h("h3", { class: "group-h", title }, `${label} · ${g.items.length}`), h("ul", { class: "work-list" }, ...g.items.map((i) => workItem(i, now))));
  }
  return sec;
}

const EVENT_KIND_LABEL: Record<BotEvent["kind"], string> = { push: "push", pr: "PR", review: "review", comment: "comment", issue: "issue", branch: "branch" };

function eventRow(e: BotEvent, now: number): HTMLElement {
  return h(
    "li",
    { class: "ev" },
    h("span", { class: "age", title: time(e.at) }, age(e.at, now)),
    h("span", { class: `kind ev-${e.kind}` }, EVENT_KIND_LABEL[e.kind]),
    h(
      "span",
      { class: "what" },
      `${e.verb} `,
      link(e.url, e.target),
      e.count > 1 ? h("span", { class: "times" }, ` ×${e.count}`) : null,
      " ",
      h("span", { class: "tag" }, e.repo),
      e.title ? h("span", { class: "etitle" }, ` ${e.title}`) : null,
    ),
  );
}

function eventsSection(events: BotEvent[] | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section(`${BOT_LOGIN} activity`);
  if (!events) sec.append(h("p", { class: "note" }, unavailable(fromCache)));
  else if (events.length === 0) sec.append(h("p", { class: "note" }, "No recent public activity."));
  else sec.append(h("ul", { class: "ev-list" }, ...events.slice(0, OPS_EVENTS_SHOWN).map((e) => eventRow(e, now))));
  return sec;
}

/** The usage section's header: the most used window, e.g. "5-hour 42%", or why there is none. */
export function usageSummary(data: UsageData | undefined): string {
  if (!data) return "…";
  if (data.state !== "ok") return data.state === "none" ? "none yet" : "private";
  const known = data.usage.windows.filter((w) => w.usedPercent !== undefined);
  const top = known.reduce<UsageWindow | undefined>((a, w) => (a && (a.usedPercent ?? 0) >= (w.usedPercent ?? 0) ? a : w), undefined);
  if (!top || top.usedPercent === undefined) return `${tokensText(data.usage.windows.reduce((n, w) => Math.max(n, tokenTotal(w.tokens)), 0))} tokens`;
  const pct = top.usedPercent;
  return `${WINDOW_LABEL[top.kind] ?? top.kind.replace(/_/g, " ")} ${pct % 1 ? pct.toFixed(1) : String(pct)}%`;
}

/**
 * The ops detail: the controller, devspaces, the coordinator's local agents, agent runs,
 * active work and the bot's activity. The changes feed and the usage
 * have sections of their own.
 */
export function opsDetail(ops: Ops | undefined, now: number = Date.now()): HTMLElement {
  const root = h("div", { class: "ops" });
  if (!ops) {
    root.append(h("p", { class: "empty" }, "Loading…"));
    return root;
  }
  for (const w of ops.warnings) root.append(h("p", { class: "warn" }, w));
  const t = tiles(ops.devspaces, now);
  if (t) root.append(t);
  root.append(
    controllerSection(ops.controller, ops.local, now, ops.fromCache),
    devspacesSection(ops.devspaces, now, ops.fromCache),
    localSection(ops.local, ops.devspaces, now, ops.fromCache),
    agentsSection(ops.agents, now, ops.fromCache),
    workSection(ops.work, now, ops.fromCache),
    eventsSection(ops.events, now, ops.fromCache),
  );
  return root;
}

/** Move the live times in `root` to `now`. */
export function tickOps(root: ParentNode, now: number): void {
  for (const el of root.querySelectorAll(".ctl-pass-age")) updatePassAge(el, now);
  for (const el of root.querySelectorAll(`.${TICK_SINCE}`)) {
    el.textContent = duration(now - Number(el.getAttribute(ATTR_T)));
  }
  for (const el of root.querySelectorAll(`.${TICK_LEFT}`)) {
    el.textContent = leftText(Number(el.getAttribute(ATTR_T)) - now, el.getAttribute(ATTR_MAX) === "1");
  }
  for (const el of root.querySelectorAll(`.${TICK_BAR}`)) {
    const left = Math.max(0, Number(el.getAttribute(ATTR_T)) - now);
    const total = Number(el.getAttribute(ATTR_TOTAL));
    if (total > 0) el.setAttribute("width", String((left / total) * 100));
  }
}
