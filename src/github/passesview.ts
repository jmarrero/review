// Read-only pass publication view. No controls or scheduling decisions.
import { type Child, h, link } from "../dom.ts";
import { time } from "../time.ts";
import {
  type FlightPr, type FlightRun, type InFlight, nothingReady, type NoStart, type Pass, type Passes, type Pool, type Pools,
  readyEvidence, redactAddresses, type RunRef, stale, type Start, underPace,
} from "./passes.ts";
import type { Active } from "./inbox.ts";
import { agoLabel } from "./view.ts";
import { passView, type PassView } from "./passview.ts";

export interface PassesRead {
  data?: Passes;
  unavailable?: string;
  absent?: boolean;
}

/** Retain cached/history facts on failure; only a complete absent read drops them. */
export function readPasses(prev: PassesRead, active: Active): PassesRead {
  const source = active.sources?.holds;
  const p = active.passes;
  const last = prev.data ?? (typeof p === "object" && p !== null ? p : undefined);
  const kept = last ? { data: last } : {};
  if (source && source.state !== "ok") return { ...(last || !prev.absent ? kept : { absent: true }), unavailable: `couldn't confirm it (${redactAddresses(source.error ?? source.state)})` };
  if (p === undefined) return prev;
  if (p === null) return { absent: true };
  if (typeof p === "string") return { ...kept, unavailable: `the publication can't be used (${p})` };
  return { data: p };
}

export const itemHref = (item: string): string => `https://github.com/${item.replace("#", "/issues/")}`;
export const runHref = (r: RunRef): string => `https://github.com/${r.repository}/actions/runs/${r.id}${r.attempt ? `/attempts/${r.attempt}` : ""}`;
const runText = (r: RunRef): string => `run ${r.id}${r.attempt && r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}`;

export function countdown(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return "due";
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440);
  const hrs = Math.floor((m % 1440) / 60);
  return `in ${[d && `${d}d`, hrs && `${hrs}h`, m % 60 && `${m % 60}m`].filter(Boolean).join(" ") || "0m"}`;
}

const when = (iso: string, now: number): HTMLElement => h("span", { title: time(iso) }, `${time(iso)} (${countdown(iso, now)})`);

function startRow(s: Start | FlightRun, label?: string): HTMLElement {
  return h("li", { class: "pass-start" },
    label ? h("span", { class: `pass-state pass-${label}` }, label === "uncertain" ? "uncertain: check the runs" : label) : null,
    label ? " " : "",
    link(itemHref(s.item), s.item), ` · ${s.kind} · ${s.pool ? `pool ${s.pool}` : "pool unknown"} · `,
    s.run ? link(runHref(s.run), runText(s.run)) : "run not known");
}

function reasonText(r: NoStart, p: Pass, now: number): Child[] {
  const item = r.item ? [link(itemHref(r.item), r.item), ": "] : [];
  const deadline = r.until ? [" until ", when(r.until, now)] : [];
  switch (r.reason) {
    case "no-ready-work":
      return readyEvidence(p)
        ? [...item, `no ready work (${p.candidates!.read} candidates read)`, ...deadline]
        : [...item, "no ready work reported, but the pass did not read everything: unknown", ...deadline];
    case "replan-wait":
      return [...item, "waiting out the re-plan delay until ", when(r.until!, now)];
    case "capped":
      return [...item, `capped${r.cap ? ` by ${r.cap}` : ""}`, ...deadline];
    case "held":
      return [...item, `held${r.hold ? ` (${r.hold})` : ""}`, ...deadline];
    default:
      return [...item, `not started: ${r.reason}`, ...deadline];
  }
}

function omittedNote(p: Pass): string {
  const parts = [[p.omitted.sections, "sections"], [p.omitted.starts, "starts"], [p.omitted.noStart, "reasons"]] as const;
  const left = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return left.length ? `Left out to fit: ${left.join(", ")}.` : "";
}

function passRow(p: Pass, now: number): HTMLElement {
  const seconds = Math.round((Date.parse(p.finishedAt) - Date.parse(p.startedAt)) / 1000);
  const head = h("p", { class: "pass-head" },
    h("span", { class: `pass-result pass-${p.result}` }, p.result), ` · ${p.mode} · started `, agoLabel(p.startedAt, now), ` · took ${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}`,
    p.run ? h("span", {}, " · ", link(runHref(p.run), runText(p.run))) : "");
  const el = h("li", { class: "pass-record" }, head);
  const problems = p.sections.filter((s) => s.outcome === "failed" || s.outcome === "cut-short");
  if (problems.length) el.append(h("ul", { class: "pass-errors" }, ...problems.map((s) => h("li", {}, `${s.name}: ${s.outcome === "failed" ? s.error : "cut short"}`))));
  const confirmed = p.starts.filter((s) => s.state === "confirmed").length;
  const atLeast = p.omitted.starts ? "at least " : "";
  el.append(h("p", {}, p.mode === "preview" ? `Would start ${atLeast}${p.starts.length}` : `Started ${atLeast}${confirmed}${p.starts.length > confirmed ? `, ${p.starts.length - confirmed} uncertain` : ""}`));
  if (p.starts.length) el.append(h("ul", {}, ...p.starts.map((s) => startRow(s, s.state === "confirmed" ? undefined : s.state))));
  if (p.noStart.length) el.append(h("ul", { class: "pass-reasons" }, ...p.noStart.map((r) => h("li", {}, ...reasonText(r, p, now)))));
  else if (!p.starts.length && !p.omitted.starts && !p.omitted.noStart) el.append(h("p", { class: "warn" }, "Started nothing, and the pass published no reason: unknown."));
  const omitted = omittedNote(p);
  if (omitted) el.append(h("p", { class: "note" }, omitted));
  return el;
}

function poolRow(p: Pool, flag: boolean, now: number): HTMLElement {
  const pct = (n: number | null) => (n === null ? "unknown" : `${+n.toFixed(1)}%`);
  const el = h("li", { class: "pass-pool" },
    h("strong", {}, p.pool), ` ${pct(p.usedPercent)} used of ${pct(p.allowedPercent)} allowed · reset `,
    p.resetsAt ? when(p.resetsAt, now) : "unknown",
    ` · ready ${p.ready ?? "unknown"}${p.held ? " · held" : p.held === null ? " · held unknown" : ""} · read `, agoLabel(p.observedAt, now));
  const old = stale(p.observedAt, now);
  if (old) el.append(h("span", { class: "pass-flag" }, " stale reading"));
  if (flag && !old && p.held === false && p.resetsAt !== null && Date.parse(p.resetsAt) > now && p.ready === 0 && underPace(p)) el.append(h("span", { class: "pass-flag" }, " well under pace with nothing ready"));
  return el;
}

function observedLine(o: Pools | InFlight, what: string, now: number): HTMLElement {
  const old = stale(o.observedAt, now);
  return h("p", { class: old || !o.complete || o.omitted ? "warn" : "note" },
    `${what} read `, agoLabel(o.observedAt, now), old ? " — stale" : "",
    o.complete ? "" : " — not read whole, so what is missing is unknown", o.omitted ? ` — ${o.omitted} left out to fit` : "");
}

function poolsBlock(data: Passes, now: number): HTMLElement[] {
  const p = data.pools;
  if (p === null) return [h("p", { class: "note" }, "Pool pace not published: unknown.")];
  if (typeof p === "string") return [h("p", { class: "warn" }, `Pool pace unreadable (${p}): unknown.`)];
  const flag = nothingReady(data, now);
  return [observedLine(p, "Pools", now), p.items.length ? h("ul", {}, ...p.items.map((x) => poolRow(x, flag, now))) : h("p", { class: "note" }, "No pools listed.")];
}

function prRow(pr: FlightPr, now: number): HTMLElement {
  return h("li", {}, link(`https://github.com/${pr.repository}/pull/${pr.number}`, `${pr.repository}#${pr.number}`),
    pr.state === "merge-queue" ? " · in the merge queue" : " · waiting for review", pr.since ? h("span", {}, " since ", agoLabel(pr.since, now)) : "");
}

function inFlightBlock(data: Passes, now: number): HTMLElement[] {
  const f = data.inFlight;
  if (f === null) return [h("p", { class: "note" }, "Work in flight not published: unknown.")];
  if (typeof f === "string") return [h("p", { class: "warn" }, `Work in flight unreadable (${f}): unknown.`)];
  const whole = f.complete && !f.omitted && !stale(f.observedAt, now) && !stale(data.publishedAt, now);
  return [observedLine(f, "Work in flight", now), h("h4", {}, `Runs (${f.runs.length})`),
    f.runs.length ? h("ul", {}, ...f.runs.map((r) => startRow(r))) : h("p", { class: "note" }, whole ? "None running." : "None listed: unknown."),
    h("h4", {}, `Pull requests (${f.prs.length})`),
    f.prs.length ? h("ul", {}, ...f.prs.map((pr) => prRow(pr, now))) : h("p", { class: "note" }, whole ? "None queued or waiting for review." : "None listed: unknown.")];
}

export function passesView(read: PassesRead, now = Date.now()): HTMLElement {
  const el = h("section", { class: "pass-view", "aria-label": "Scheduler passes" }, h("h2", {}, "Scheduler passes"));
  const data = read.data;
  if (read.unavailable) el.append(h("p", { class: "warn" }, `Pass publication unavailable: ${read.unavailable}.${data ? " What follows is the last one read." : ""}`));
  if (!data) {
    el.append(h("p", { class: "note" }, read.unavailable ? "Nothing known about recent passes."
      : read.absent ? "Not published: agent-board's holds.passes is off, or the pass is older than agent-board/passes/v1. Nothing known about recent passes."
        : "Reading the pass publication…"));
    return el;
  }
  const old = stale(data.publishedAt, now);
  el.append(h("p", { class: old ? "warn" : "note" }, "Published ", agoLabel(data.publishedAt, now),
    Date.parse(data.publishedAt) > now + 300_000 ? " — clock is in the future; current state unknown" : old ? " — stale: the pass may have stopped, or failed to publish" : "",
    ` · newest ${data.retention} passes kept`, data.omitted ? ` · ${data.omitted} left out to fit` : "", data.unreadable ? ` · ${data.unreadable} unreadable, left out` : ""));
  el.append(h("h3", {}, "Recent passes"));
  el.append(data.passes.length ? h("ol", { class: "pass-list" }, ...data.passes.map((p) => passRow(p, now)))
    : h("p", { class: "warn" }, "No readable pass records: unknown, not idle."));
  const evidence = read.unavailable ? { ...data, pools: typeof data.pools === "object" && data.pools ? { ...data.pools, complete: false } : data.pools,
    inFlight: typeof data.inFlight === "object" && data.inFlight ? { ...data.inFlight, complete: false } : data.inFlight } : data;
  el.append(h("h3", {}, "Pool pace"), ...poolsBlock(evidence, now));
  el.append(h("h3", {}, "Work in flight"), ...inFlightBlock(evidence, now));
  return el;
}

/** One Status panel, preserving the deployed legacy producer. */
export function schedulerPassView(read: PassesRead, legacy: PassView | string | undefined, now = Date.now(), unavailable?: string): HTMLElement {
  return read.absent && legacy !== undefined ? passView(legacy, now, unavailable) : passesView(read, now);
}
