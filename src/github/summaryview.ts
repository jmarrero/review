// The summary at the top of the page: one line each for the agents
// running, the runs queued, the scheduler and the pools, each linking to
// the section with the detail. It reads nothing of its own: it is made
// from what the sections already read, so it adds no GitHub request and
// follows their refresh rules (none while the tab is hidden). The
// scheduler's line needs the controller's runs, which only the ops
// detail reads; until it is opened the line says so. Each line says what
// its state means (new work held until when, a stale reading's age, agents
// not confirmed running) rather than a bare word to be looked up.

import { h, link } from "../dom.ts";
import type { ActiveAgent } from "./agents.ts";
import type { ControllerData, PieceState } from "./controller.ts";
import { duration, monthGone, poolStateWords, poolWords } from "./opsview.ts";
import type { PageState } from "./state.ts";

/** Agents linked by name on the line; the rest are counted. */
const AGENTS_LINKED = 4;
/** Statuses of a run that hasn't started. */
const QUEUED = new Set(["queued", "waiting", "pending", "requested"]);
const POOLS = [["claude", "Claude"], ["openai", "OpenAI"]] as const;

export interface SummaryTargets {
  /** Open (if need be) and scroll to a section of the page. */
  show(id: string): void;
}

/** A link to a part of the page that opens it, without touching the hash (which is the route). */
function jump(id: string, text: string, targets: SummaryTargets): HTMLElement {
  const a = h("a", { href: `#${id}`, class: "sum-jump" }, text);
  a.addEventListener("click", (event) => {
    event.preventDefault();
    targets.show(id);
  });
  return a;
}

/** The pool an agent draws on, as far as its source says: its engine, else where it runs. */
const poolOf = (a: ActiveAgent) => a.engine ?? (a.location === "remote" ? "Actions" : "local");

function agentsLine(state: PageState, targets: SummaryTargets): HTMLElement {
  const s = state.agents;
  const running = s.agents.filter((a) => !a.stale);
  const line = h("li", {}, jump("sec-agents", "Agents", targets), " ");
  if (!s.executionKnown) return (line.append("not read yet"), line);
  const by = new Map<string, number>();
  for (const a of running) by.set(poolOf(a), (by.get(poolOf(a)) ?? 0) + 1);
  // Unconfirmed: a board claim or a sighting with no current run or
  // heartbeat behind it, so not counted as running (see agents.ts).
  line.append(`${running.length} running`, by.size ? ` (${[...by].map(([pool, n]) => `${pool} ${n}`).join(", ")})` : "", s.unconfirmed ? ` · ${s.unconfirmed} claimed or last seen, not confirmed running` : "");
  running.slice(0, AGENTS_LINKED).forEach((a) => {
    line.append(" · ", link(a.runUrl ?? a.itemUrl, a.itemRef ?? a.name));
  });
  if (running.length > AGENTS_LINKED) line.append(` · +${running.length - AGENTS_LINKED}`);
  return line;
}

function queuedLine(state: PageState, targets: SummaryTargets): HTMLElement {
  const runs = state.runs?.runs;
  const queued = runs?.filter((r) => r.active && QUEUED.has(r.status)) ?? [];
  return h("li", {}, jump("live-runs", "Queued", targets), " ", runs ? `${queued.length} run${queued.length === 1 ? "" : "s"}` : "not read yet", ...queued.slice(0, AGENTS_LINKED).flatMap((r) => [" · ", link(r.url, r.title)]));
}

function ago(at: string | undefined, now: number): string {
  const t = Date.parse(at ?? "");
  return Number.isFinite(t) ? `${duration(Math.max(0, now - t), false)} ago` : "time unknown";
}

/**
 * The board scheduler's mode (what BOARD_DISPATCH makes it do), the poll's
 * last pass and the broker probe's last run (it has only a schedule, so
 * every run is the default branch's). The probe's job runs only
 * while tracker's BROKER_OUTAGE is apply, so otherwise it reads "skipped".
 */
function schedulerLine(controller: ControllerData | undefined, now: number, targets: SummaryTargets): HTMLElement {
  const line = h("li", {}, jump("ops", "Scheduler", targets), " ");
  if (!controller) return (line.append("mode and last passes not read: they are read when the ops detail is opened"), line);
  const piece = (label: string): PieceState | undefined => controller.pieces.find((p) => p.piece.label === label);
  const pass = (p: PieceState | undefined) => !p?.last ? "no pass" : p.last.conclusion === "success" ? `ok ${ago(p.last.at, now)}` : `${p.last.conclusion ?? "ended"} ${ago(p.last.at, now)}`;
  const board = piece("Board scheduler");
  const mode = board?.scheduler?.mode;
  line.append(
    `board ${mode === "acting" ? "dispatching" : mode === "preview" ? "previewing (dry run)" : "mode unknown"}`,
    ` · poll ${pass(piece("Poll"))}`,
    ` · broker ${pass(piece("Broker probe"))}`,
  );
  return line;
}

function resourcesLines(state: PageState, now: number, targets: SummaryTargets): HTMLElement[] {
  const usage = state.usage?.state === "ok" ? state.usage.usage : undefined;
  if (!usage) return [h("li", {}, jump("weekly-usage", "Resources", targets), !state.usage ? " not read yet" : state.usage.state === "unreadable" ? " unreadable with this token" : " not published")];
  const lines = POOLS.flatMap(([name, label]) => {
    const pool = usage.pools?.[name];
    if (!pool) return [];
    const { held, stale } = poolStateWords(pool, now);
    // Over pace as the pool's row has it: used beyond what the scheduler allows by now, held or not yet.
    const over = pool.usedPercent > pool.allowedPercent ? ` · over pace: ${Math.round(pool.allowedPercent)}% allowed by now` : "";
    return [h("li", pool.hold || over ? { class: "hot" } : {}, jump("weekly-usage", label, targets), ` ${poolWords(pool).short}${over}${held}${stale}`)];
  });
  const m = usage.mistral;
  if (m?.allowance) lines.push(h("li", {}, jump("weekly-usage", "Mistral", targets), ` $${m.allowance.spentUsd.toFixed(2)}${m.allowance.estimated ? " est." : ""} of $${m.allowance.limitUsd} this month`));
  else if (m?.budget) lines.push(h("li", {}, jump("weekly-usage", "Mistral", targets), ` spend not published · $${m.budget.limitUsd} a month, ${Math.round(monthGone(m.budget, now))}% gone`));
  return lines;
}

/** The summary's lines; a short list a phone shows without scrolling. */
export function summaryView(state: PageState, controller: ControllerData | undefined, now: number, targets: SummaryTargets): HTMLElement {
  return h(
    "section",
    { class: "dashboard-summary", "aria-label": "Summary" },
    h("ul", {}, agentsLine(state, targets), queuedLine(state, targets), schedulerLine(controller, now, targets), ...resourcesLines(state, now, targets)),
  );
}
