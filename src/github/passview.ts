// Optional publication only: no log scraping or target discovery. The only
// writes are Live agents' actions on runs it lists (agentruns.ts).
import { h } from "../dom.ts";
import { ago } from "../time.ts";
import { AGE_EXPIRES_ATTR, AGE_FROZEN_ATTR, ageLabel } from "./view.ts";
import { isObject, time } from "./heartbeat.ts";
import { redactAddresses } from "./passes.ts";

interface Run { repository: string; id: number }
interface Start { item: string; kind: string; pool: string; run: Run }
/** A run the pass view lists, as the Live agents actions name it. */
export type AgentRun = Start;
interface Reason { item: string | null; kind: "no-ready-work" | "replan-delay" | "capped" | "held"; reason: string; until: string | null }
interface Pass { at: string; result: "success" | "partial" | "failure"; sections: { name: string; result: "success" | "skipped" | "failure"; error: string | null }[]; started: Start[]; reasons: Reason[]; omitted: number }
interface Pool { name: string; used_percent: number | null; allowed_percent: number | null; resets_at: string | null; ready: number | null; under_pace: boolean | null }
type Flight = { state: "running"; item: string; kind: string; pool: string; run: Run; started_at?: string | null } | { state: "merge-queue" | "waiting-review"; repository: string; number: number };
export interface PassView { schema: "agent-board/pass-view/v1"; observed_at: string; complete: boolean; omitted: number; passes: Pass[]; pools: Pool[]; in_flight: Flight[] }

// A hostile/oversized publication must not create unbounded DOM or arbitrary links.
const token = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\r\n\x00-\x1f\x7f]/.test(v);
const repository = (v: unknown): v is string => typeof v === "string" && v.length <= 201 && v.split("/").length === 2 && v.split("/").every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== "." && s !== "..");
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
const item = (v: unknown): v is string => typeof v === "string" && repository(v.split("#")[0]) && /^[^#]+#[1-9]\d{0,9}$/.test(v);
const run = (v: unknown): boolean => isObject(v) && repository(v.repository) && positive(v.id);
const list = (v: unknown, max: number, check: (v: unknown) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(check);
const percent = (v: unknown): boolean => v === null || typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const start = (v: unknown): boolean => isObject(v) && item(v.item) && token(v.kind) && token(v.pool) && run(v.run);

/** Reject the extension as a whole: malformed entries are not evidence of nothing running. */
export function parsePassView(raw: unknown): PassView | string {
  if (!isObject(raw) || raw.schema !== "agent-board/pass-view/v1" || !time(raw.observed_at) || typeof raw.complete !== "boolean" || !count(raw.omitted)
    || !list(raw.passes, 8, (p) => isObject(p) && !!time(p.at) && ["success", "partial", "failure"].includes(p.result as string) && count(p.omitted)
      && list(p.sections, 12, (s) => isObject(s) && token(s.name) && ["success", "skipped", "failure"].includes(s.result as string) && (s.result === "failure" ? text(s.error) : s.error === null))
      && list(p.started, 32, start)
      && list(p.reasons, 32, (r) => isObject(r) && (r.item === null || item(r.item)) && ["no-ready-work", "replan-delay", "capped", "held"].includes(r.kind as string) && text(r.reason) && (r.kind === "replan-delay" ? !!time(r.until) : r.until === null)))
    || !list(raw.pools, 16, (p) => isObject(p) && token(p.name) && percent(p.used_percent) && percent(p.allowed_percent) && (p.resets_at === null || !!time(p.resets_at)) && (p.ready === null || count(p.ready)) && (p.under_pace === null || typeof p.under_pace === "boolean"))
    || !list(raw.in_flight, 100, (f) => isObject(f) && (f.state === "running" ? start(f) && (f.started_at == null || !!time(f.started_at)) : ["merge-queue", "waiting-review"].includes(f.state as string) && repository(f.repository) && positive(f.number)))) {
    return "Pass view unavailable: malformed or over its publication bounds.";
  }
  // Only validated fields are consumed below; unknown extension fields are ignored.
  return raw as unknown as PassView;
}

/** While the publication can't be read, the last readable view stays, marked last read by passView's warning. */
export function retainPassView(last: PassView | undefined, read: PassView | string | undefined, unavailable: boolean): PassView | string | undefined {
  return unavailable && last && typeof read !== "object" ? last : read;
}

function itemLink(ref: string): HTMLElement {
  return h("a", { href: `https://github.com/${ref.replace("#", "/issues/")}` }, ref);
}

function runLink(ref: Run): HTMLElement {
  return h("a", { href: `https://github.com/${ref.repository}/actions/runs/${ref.id}` }, `run ${ref.id}`);
}

function startLine(s: Start): HTMLElement {
  return h("li", {}, itemLink(s.item), ` · ${s.kind} · ${s.pool} · `, runLink(s.run));
}

export function passView(data: PassView | string | undefined, now = Date.now(), unavailable?: string): HTMLElement {
  const el = h("section", { class: "pass-view", "aria-label": "Poller passes" }, h("h2", {}, "Poller passes"));
  if (!publicationNote(el, data, now, unavailable)) return el;
  el.append(h("h3", {}, "Last passes"));
  if (!data.passes.length) el.append(h("p", {}, "No pass history published; not evidence that no pass ran."));
  for (const p of data.passes) {
    const row = h("article", { class: "pass-record" }, h("h4", {}, `${p.at} · ${p.result}`));
    row.append(h("ul", {}, ...p.sections.map((s) => h("li", { class: s.result === "failure" ? "warn" : "" }, `${s.name}: ${s.result}${s.error ? ` — ${redactAddresses(s.error)}` : ""}`))));
    row.append(h("p", {}, `Started ${p.started.length}${p.omitted ? " shown" : ""}`), h("ul", {}, ...p.started.map(startLine)));
    if (!p.started.length && !p.reasons.length) row.append(h("p", { class: "warn" }, "Started nothing; reason not published."));
    row.append(h("ul", {}, ...p.reasons.map((r) => h("li", {}, r.item ? itemLink(r.item) : "New runs", ` · ${r.kind}: ${redactAddresses(r.reason)}${r.until ? ` · until ${r.until}` : ""}`))));
    if (p.omitted) row.append(h("p", { class: "warn" }, `${p.omitted} pass records omitted; starts and reasons may be incomplete.`));
    el.append(row);
  }
  el.append(h("h3", {}, "Pool pace"));
  if (!data.pools.length) el.append(h("p", {}, "Pool pace not published."));
  for (const p of data.pools) {
    const reset = p.resets_at ? Math.ceil((Date.parse(p.resets_at) - now) / 60_000) : null;
    el.append(h("p", {}, `${p.name}: ${p.used_percent ?? "unknown"}% used / ${p.allowed_percent ?? "unknown"}% allowed · reset ${p.resets_at ?? "unknown"}${reset === null ? "" : reset > 0 ? ` (in ${reset}m)` : " (due; awaiting reading)"} · ready ${p.ready ?? "unknown"}${p.under_pace === true ? " · under pace (publisher assessment; readiness coverage unknown)" : ""}`));
  }
  el.append(h("h3", {}, "Work in flight"));
  if (!data.in_flight.length) el.append(h("p", {}, "No work in flight listed; incomplete publication is not an empty queue."));
  el.append(h("ul", {}, ...data.in_flight.map((f) => f.state === "running" ? startLine(f) : h("li", {}, h("a", { href: `https://github.com/${f.repository}/pull/${f.number}` }, `${f.repository}#${f.number}`), ` · ${f.state}`))));
  return el;
}

function publicationNote(el: HTMLElement, data: PassView | string | undefined, now: number, unavailable?: string): data is PassView {
  if (unavailable) el.append(h("p", { class: "warn" }, `Publication unavailable: ${redactAddresses(unavailable)}. Any facts below are last read, not current.`));
  if (!data || typeof data === "string") {
    el.append(h("p", { class: "note" }, data ?? "Pass view not published (off or older producer)."));
    return false;
  }
  const age = now - Date.parse(data.observed_at);
  el.append(h("p", { class: age > 3_600_000 || age < -60_000 ? "warn" : "note" }, `Observed ${data.observed_at}${age > 3_600_000 ? " · stale (over an hour)" : age < -60_000 ? " · clock is in the future" : ""} · ${data.complete ? "publisher reports complete" : "partial; unread work is unknown"} · ${data.omitted} records omitted`));
  el.append(h("p", { class: "note" }, "Legacy pass view: section errors, readiness and queued/review-wait PR coverage may be missing; missing facts are unknown."));
  return true;
}

/** Live agents' writes (agentruns.ts), given only to OPERATOR; each resolves to what it made or acted on. */
export interface AgentActions {
  cancel(r: AgentRun): Promise<string>;
  retry(r: AgentRun): Promise<string>;
  redispatch(r: AgentRun): Promise<string>;
  confirm(message: string): boolean;
}

/** At most this many finished starts get Retry and Redispatch: the newest, not the whole history. */
const MAX_FINISHED = 5;
/** Past this the observation can't vouch for a run still going, so its runtime stops ticking. */
const FRESH_MS = 3_600_000;
const ACTION_ATTR = "data-agent-action";

/** What an action on a run came to; `busy` while it is sending, or once it went out or may have. */
type Outcome = { by: string; text: string; url?: string; busy: boolean };
/**
 * Actions sent from this tab, by run, not by button: once Redispatch went
 * out, Retry on the same failed run would start a second job. The panel is
 * redrawn on every poll, and a sent one stays sent.
 */
const outcomes = new Map<string, Outcome>();

function paintAction(button: HTMLButtonElement, status: HTMLElement, key: string): void {
  const o = outcomes.get(key);
  // A refusal changed nothing: offer the buttons again.
  button.disabled = o?.busy ?? false;
  if (o?.by === button.textContent) status.replaceChildren(o.text, o.url ? h("a", { href: o.url }, o.url) : "");
  else status.replaceChildren();
}

export function actionButton(label: string, verb: string, r: AgentRun, act: (r: AgentRun) => Promise<string>, confirm: (m: string) => boolean): HTMLElement {
  const key = `${r.run.repository}/${r.run.id}`;
  const button = h("button", { type: "button", class: "agent-action", [ACTION_ATTR]: key }, label);
  const status = h("span", { class: "note", role: "status" });
  paintAction(button, status, key);
  button.addEventListener("click", () => {
    if (outcomes.get(key)?.busy || !confirm(`${verb} ${r.item}'s ${r.kind} run ${r.run.id} (${r.run.repository}) with your token?`)) return;
    const repaint = () => {
      // The click's own button may have been redrawn away meanwhile: paint whichever show this run now.
      paintAction(button, status, key);
      for (const b of document.querySelectorAll<HTMLButtonElement>(`button[${ACTION_ATTR}]`)) {
        const s = b.nextElementSibling as HTMLElement | null;
        if (b !== button && b.getAttribute(ACTION_ATTR) === key && s) paintAction(b, s, key);
      }
    };
    outcomes.set(key, { by: label, text: "Sending…", busy: true });
    repaint();
    act(r).then((url) => outcomes.set(key, { by: label, text: "Sent: ", url, busy: true }), (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      // An uncertain write stays disabled: check GitHub, don't send it twice.
      const uncertain = e instanceof Error && e.name === "MaybeSentError";
      outcomes.set(key, { by: label, text: `${uncertain ? "Uncertain" : "Not sent"}: ${message}`, busy: uncertain });
    }).finally(repaint);
  });
  return h("span", { class: "agent-actions" }, button, status);
}

/** Forget what this tab sent; for tests. */
export function resetAgentActions(): void {
  outcomes.clear();
}

/** Compact home summary of the same bounded publication used by Status. */
/**
 * `live`, where given, is the Live agents list read from the Actions API
 * (liveruns.ts): it shows first, and in place of the pass view's own list
 * of running jobs, whether or not the pass view is published.
 */
export function activePassView(data: PassView | string | undefined, now = Date.now(), unavailable?: string, actions?: AgentActions, control?: HTMLElement, live?: HTMLElement): HTMLElement {
  const el = h("section", { class: "active-pass", "aria-label": "Agents and capacity" }, h("h2", {}, "Agents and capacity"));
  if (live) el.append(live);
  if (!publicationNote(el, data, now, unavailable)) {
    if (control) el.append(control);
    return el;
  }
  const agents = h("div", {}, live ? "" : h("h3", {}, "Live agents"));
  const running = data.in_flight.flatMap((f) => (f.state === "running" ? [f] : []));
  const observed = Date.parse(data.observed_at);
  const fresh = !unavailable && now - observed <= FRESH_MS && now >= observed - 60_000;
  const rows = live ? [] : running.map((f) => {
    const elapsed = f.started_at ? observed - Date.parse(f.started_at) : NaN;
    // Ticks (tickAges) only while the observation is fresh; a stale one says what it saw.
    const frozen = `${Math.floor(elapsed / 60_000)}m at observation`;
    const label = ageLabel(f.started_at ?? undefined, now);
    label.setAttribute(AGE_EXPIRES_ATTR, String(observed + FRESH_MS));
    label.setAttribute(AGE_FROZEN_ATTR, frozen);
    const runtime = !(elapsed >= 0) ? ["runtime unknown"] : fresh ? ["running ", label] : [`running ${frozen}`];
    return h("li", {}, itemLink(f.item), ` · ${f.kind} · ${f.pool} · `, ...runtime, " · ", runLink(f.run),
      actions ? actionButton("Cancel", "Cancel", f, actions.cancel, actions.confirm) : null);
  });
  if (!live) agents.append(rows.length ? h("ul", {}, ...rows) : h("p", {}, "No running jobs listed; unread work is unknown."));
  // Started by a listed pass and no longer running: finished, or not yet listed. Its result is read only when acted on.
  const seen = new Set(running.map((f) => `${f.run.repository.toLowerCase()}/${f.run.id}`));
  const finished = data.passes.flatMap((p) => p.started.map((s) => ({ s, at: p.at }))).filter(({ s }) => {
    const key = `${s.run.repository.toLowerCase()}/${s.run.id}`;
    return !seen.has(key) && !!seen.add(key);
  }).slice(0, MAX_FINISHED);
  if (finished.length) {
    agents.append(h("h4", {}, "Recently started, not listed running"), h("ul", {}, ...finished.map(({ s, at }) => h("li", {}, itemLink(s.item), ` · ${s.kind} · ${s.pool} · started `, h("time", { datetime: at, title: at }, ago(at, now)), " · ", runLink(s.run),
      actions ? actionButton("Retry", "Rerun the failed jobs of", s, actions.retry, actions.confirm) : null,
      actions ? actionButton("Redispatch", "Reply with the newest plan, redispatching", s, actions.redispatch, actions.confirm) : null))));
    if (actions) agents.append(h("p", { class: "note" }, "Retry and Redispatch read the run first and act only if it failed."));
  }
  const capacity = h("div", {}, h("h3", {}, "Capacity"));
  if (!data.pools.length) capacity.append(h("p", {}, "Capacity not published."));
  for (const p of data.pools) {
    const label = `${p.name}: ${p.used_percent ?? "unknown"}% used / ${p.allowed_percent ?? "unknown"}% allowed`;
    capacity.append(h("div", { class: "capacity-pool" }, h("p", { class: p.under_pace === true ? "warn" : "" }, `${label} · reset ${p.resets_at ?? "unknown"}${p.under_pace === true ? " · under pace (publisher assessment)" : ""}`),
      p.used_percent === null ? h("p", { class: "note" }, "Usage unknown") : h("meter", { min: "0", max: "100", value: String(p.used_percent), low: String(p.allowed_percent ?? 100), high: String(p.allowed_percent ?? 100), optimum: "0", "aria-label": label }, label)));
  }
  if (control) capacity.append(control);
  const last = h("div", {}, h("h3", {}, "Last pass"));
  const p = data.passes[0];
  if (!p) last.append(h("p", {}, "Last pass not published."));
  else {
    last.append(h("p", {}, h("time", { datetime: p.at, title: p.at }, ago(p.at, now)), ` · ${p.result} · Started ${p.started.length}${p.omitted ? " shown" : ""}`));
    if (p.started.length) last.append(h("ul", {}, ...p.started.map(startLine)));
    {
      const counts = new Map<string, number>();
      for (const r of p.reasons) {
        const key = `${r.kind}: ${redactAddresses(r.reason)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      if (counts.size) last.append(h("p", { class: "note" }, "No-start reasons"), h("ul", {}, ...[...counts].sort((a, b) => b[1] - a[1]).map(([reason, n]) => h("li", {}, `${reason} · ${n}`))));
      else if (!p.started.length) last.append(h("p", { class: "warn" }, "Started nothing; reason not published."));
    }
    if (p.omitted) last.append(h("p", { class: "warn" }, `${p.omitted} pass records omitted; starts and reasons may be incomplete.`));
  }
  el.append(h("div", { class: "active-pass-grid" }, ...(agents.childNodes.length ? [agents] : []), capacity, last));
  return el;
}
