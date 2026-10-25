// The one page: collapsible sections (see sections.ts) that main.ts fills
// as their data arrives. The skeleton is built once and stays in place
// across data refreshes, so a section's open state, a half-typed answer
// and the scroll position are not lost when something behind them
// changes. Every section shows its count in its header and a few rows
// before "View all".

import { h } from "../dom.ts";
import { TRACKER_REPO } from "./config.ts";
import { DECISIONS_CONFIG } from "./decisiondocument.ts";
import { CONTROLLER, parseControllerConfig } from "./controller.ts";
import { runsPanel } from "./runsview.ts";
import type { PageState } from "./state.ts";
import type { Renderer } from "../markdown.ts";
import type { Active, AgentSummary } from "./agents.ts";
import { agentsBody, agentsSummary } from "./agentsview.ts";
import { blockedBy, type Item } from "./board.ts";
import { diffBoard, type Snapshot } from "./boardfeed.ts";
import { type FeedOptions, feedSection } from "./boardfeedview.ts";
import type { QueueFilter } from "./filter.ts";
import type { Heartbeat } from "./heartbeat.ts";
import type { News } from "./news.ts";
import { newsList } from "./newsview.ts";
import type { People } from "./people.ts";
import { peopleView, type PeopleHooks } from "./peopleview.ts";
import { ALL_PRIORITIES, type Need, waitingCount } from "./needs.ts";
import { applyPriority, NEED_CLASS, NEED_FILTERED_CLASS, NEED_ORDER_ATTR, needRow, needsHead, type NeedsHooks, WATCHING_CLASS, WATCHING_ITEM_CLASS } from "./needsview.ts";
import { type Ops } from "./ops.ts";
import { opsDetail, POOL_ATTR, usageSection, usageSummary, weeklyUsage } from "./opsview.ts";
import { type Entry, priorityRank } from "./queue.ts";
import { PREVIEW_ROWS, SECTION_HINT, SECTION_TITLE, SECTIONS, type SectionId } from "./sections.ts";
import type { OpenBoard, ProjectStatus } from "./backend.ts";
import { refKey, VERDICT_LABEL } from "./forge.ts";
import { ON_BOT_LABEL, REASON_LABEL } from "./waiting.ts";
import type { TriageFilter } from "./triage.ts";
import type { UsageData } from "./usage.ts";
import { summaryView } from "./summaryview.ts";
import type { ControllerData } from "./controller.ts";
import { triageView, type TriageHooks } from "./triageview.ts";
import { CAUGHT_UP_CLASS, clock, type ListExtras, priorityList, ROW_CLASS, type RowLabel, rowText } from "./view.ts";

/** The class of the page, of a section, and of its count. */
export const HOME_CLASS = "home";
export const SECTION_CLASS = "sec";
export const COUNT_CLASS = "sec-count";
export const VIEW_ALL_CLASS = "view-all";

function statusInterval(): number | undefined {
  try {
    // The poll's pass took over the coordinator's (tracker has no coordinator.yml), so its interval.
    return parseControllerConfig(CONTROLLER).hosted.find((p) => p.label === "Poll")?.staleAfterMinutes;
  } catch {
    // Invalid ops configuration must not prevent the dashboard rendering.
    return undefined;
  }
}

const STATUS_INTERVAL = statusInterval();

/** A section's parts. */
export interface SectionEls {
  details: HTMLDetailsElement;
  count: HTMLElement;
  body: HTMLElement;
}

/** The places the sections' data goes. */
export interface Slots {
  /** The summary above everything else. */
  summary: HTMLElement;
  people: HTMLElement;
  peopleCount: HTMLElement;
  runs: HTMLElement;
  freshness: HTMLElement;
  status: HTMLElement;
  focus: HTMLElement;
  needs: HTMLElement;
  decisionDocument: HTMLElement;
  agents: HTMLElement;
  /** The ops detail under the agents, and its fold. */
  ops: HTMLElement;
  opsBox: HTMLDetailsElement;
  feed: HTMLElement;
  news: HTMLElement;
  priority: HTMLElement;
  /** The themes and verdicts under the priority list, and their fold. */
  themes: HTMLElement;
  themesBox: HTMLDetailsElement;
  usage: HTMLElement;
  weekly: HTMLElement;
}

export interface Home {
  el: HTMLElement;
  sections: Record<SectionId, SectionEls>;
  slots: Slots;
  /** The open state each section is expected to have, so a toggle by code isn't taken for his. */
  expected: Map<SectionId, boolean>;
}

export interface HomeHooks {
  /** Whether each section starts open. */
  open(id: SectionId): boolean;
  /** He opened or closed a section. */
  toggled(id: SectionId, open: boolean): void;
  /** He opened or closed the ops detail, or the themes under the priority list. */
  opsToggled(open: boolean): void;
  themesToggled(open: boolean): void;
  peopleToggled?(open: boolean): void;
}

/** Sections whose "View all" is open: kept across re-renders, not across reloads. */
const expanded = new Set<string>();

/** Forget which "View all" were opened (tests). */
export function resetExpanded(): void {
  expanded.clear();
}

function section(id: SectionId, home: Pick<Home, "expected">, hooks: HomeHooks, ...body: HTMLElement[]): SectionEls {
  const count = h("span", { class: COUNT_CLASS }, "…");
  const bodyEl = h("div", { class: "sec-body" }, ...body);
  const details = h(
    "details",
    { class: `${SECTION_CLASS} sec-${id}`, id: `sec-${id}`, "data-section": id },
    h("summary", {}, h("span", { class: "sec-title" }, SECTION_TITLE[id]), count, h("span", { class: "sec-hint" }, SECTION_HINT[id])),
    bodyEl,
  );
  details.open = id === "needs" || hooks.open(id);
  home.expected.set(id, details.open);
  details.addEventListener("toggle", () => {
    if (details.open === home.expected.get(id)) return;
    home.expected.set(id, details.open);
    hooks.toggled(id, details.open);
  });
  return { details, count, body: bodyEl };
}

function fold(cls: string, label: string, onToggle: (open: boolean) => void): { box: HTMLDetailsElement; slot: HTMLElement } {
  const slot = h("div", { class: `${cls}-slot` });
  const box = h("details", { class: `sub-fold ${cls}` }, h("summary", {}, label), slot);
  box.addEventListener("toggle", () => onToggle(box.open));
  return { box, slot };
}

export function homeSkeleton(hooks: HomeHooks): Home {
  const expected = new Map<SectionId, boolean>();
  const people = h("div", { class: "people-slot sec-body" });
  const peopleCount = h("span", { class: COUNT_CLASS }, "…");
  const peopleSection = h("details", { class: `${SECTION_CLASS} sec-people`, id: "sec-people" }, h("summary", {}, h("span", { class: "sec-title" }, "From people (opt in)"), peopleCount), people);
  peopleSection.addEventListener("toggle", () => hooks.peopleToggled?.(peopleSection.open));
  const summary = h("div", { class: "summary-slot" });
  const weekly = h("section", { class: "usage-body weekly-usage", id: "weekly-usage", "aria-label": "Weekly subscription usage" }, h("h2", {}, "Weekly subscription usage"), h("p", { class: "note" }, "Reading usage…"));
  const needs = h("div", { class: "needs-slot" });
  const decisionDocument = h("div", { class: "decision-document-slot" });
  const status = h("section", { class: "dashboard-status", "aria-label": "Status" }, h("h2", {}, "Status"));
  const focus = h("section", { class: "dashboard-focus", "aria-label": "Focus" }, h("h2", {}, "Focus"));
  const runs = h("div", { class: "runs-slot", id: "live-runs" });
  const freshness = h("p", { class: "source-freshness note", "aria-label": "Source freshness" });
  const agents = h("div", { class: "agents-slot" });
  const ops = fold("ops-fold", "Devspaces, agent runs and the bot's activity", hooks.opsToggled);
  const feed = h("div", { class: "feed-slot" });
  const news = h("div", { class: "news-slot" });
  const priority = h("div", { class: "priority-slot" });
  const themes = fold("themes-fold", "Themes and verdicts (every open board item)", hooks.themesToggled);
  const usage = h("div", { class: "usage-slot" });
  const ctx = { expected };
  const sections: Record<SectionId, SectionEls> = {
    needs: section("needs", ctx, hooks, decisionDocument, needs),
    agents: section("agents", ctx, hooks, agents, ops.box),
    changes: section("changes", ctx, hooks, feed, news),
    priority: section("priority", ctx, hooks, priority, themes.box),
    usage: section("usage", ctx, hooks, usage),
  };
  const el = h("div", { class: HOME_CLASS }, summary, weekly, sections.needs.details, status, peopleSection, focus, runs, ...SECTIONS.filter((id) => id !== "needs").map((id) => sections[id].details), freshness);
  return { el, sections, slots: { summary, people, peopleCount, runs, freshness, status, focus, needs, decisionDocument, agents, ops: ops.slot, opsBox: ops.box, feed, news, priority, themes: themes.slot, themesBox: themes.box, usage, weekly }, expected };
}

export function fillState(home: Home, state: PageState): void {
  const signature = JSON.stringify([state.runs, state.sources.runs]);
  if (home.slots.runs.dataset.signature !== signature) {
    const open = new Set([...home.slots.runs.querySelectorAll<HTMLDetailsElement>("details[open]")].map((el) => el.dataset.runId));
    home.slots.runs.replaceChildren(runsPanel(state));
    home.slots.runs.dataset.signature = signature;
    for (const el of home.slots.runs.querySelectorAll<HTMLDetailsElement>("details")) el.open = open.has(el.dataset.runId);
  }
  home.slots.freshness.textContent = Object.entries(state.sources).map(([name, source]) => `${name}: ${source.state}${source.checkedAt ? ` (checked ${new Date(source.checkedAt).toLocaleTimeString()})` : source.fetchedAt ? ` (cached ${new Date(source.fetchedAt).toLocaleString()})` : ""}${source.publishedAt ? ` · published ${source.publishedAt}` : ""}${source.error ? ` — ${source.error}` : ""}`).join(" · ");
}

/**
 * The summary at the top (summaryview.ts). Its links open what they
 * point at: the section, and the ops detail for the scheduler, which
 * opening reads (as if he had opened it).
 */
export function fillSummary(home: Home, state: PageState, controller: ControllerData | undefined, now: number): void {
  // The page redraws every 15 s: keep the same lines (and focus on a link) unless what they say changed.
  const view = summaryView(state, controller, now, { show: () => {} });
  if (home.slots.summary.dataset.signature === view.textContent) return;
  home.slots.summary.dataset.signature = view.textContent ?? "";
  home.slots.summary.replaceChildren(summaryView(state, controller, now, {
    show: (id) => {
      const target = id === "ops" ? home.slots.opsBox : home.el.querySelector<HTMLElement>(`#${id}`);
      if (!target) return;
      for (let d = target.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
      target.scrollIntoView({ block: "start" });
    },
  }));
}

/** Open or close a section from code (a jump, or its default changing). With `remember`, as if he did. */
export function setSectionOpen(home: Home, id: SectionId, open: boolean, remember: boolean, hooks: Pick<HomeHooks, "toggled">): void {
  const { details } = home.sections[id];
  if (details.open === open) return;
  if (remember) hooks.toggled(id, open);
  home.expected.set(id, open);
  details.open = open;
}

/** Set a section's count, with what it says to a screen reader. */
export function setCount(home: Home, id: SectionId, text: string, opts: { title?: string; hot?: boolean } = {}): void {
  const el = home.sections[id].count;
  el.textContent = text;
  el.title = opts.title ?? "";
  el.classList.toggle("hot", opts.hot === true);
}

/**
 * Show only the first `limit` rows of `slot` (those matching `rowSelector`)
 * until "View all" is pressed, and hide the lists and groups left with
 * no row showing. The button goes at the end of the slot.
 */
export function applyLimit(slot: HTMLElement, id: string, rowSelector: string, limit: number = PREVIEW_ROWS): void {
  slot.querySelector(`:scope > .${VIEW_ALL_CLASS}`)?.remove();
  const rows = [...slot.querySelectorAll<HTMLElement>(rowSelector)];
  const all = expanded.has(id);
  rows.forEach((r, i) => {
    r.hidden = !all && i >= limit;
  });
  for (const box of slot.querySelectorAll<HTMLElement>("section.group, ul")) {
    const inside = rows.filter((r) => box.contains(r));
    const empty = inside.length > 0 && inside.every((r) => r.hidden);
    box.hidden = empty;
    const before = box.previousElementSibling;
    if (before?.tagName === "H3") (before as HTMLElement).hidden = empty;
  }
  if (rows.length <= limit) return;
  const button = h("button", { type: "button", class: `small ${VIEW_ALL_CLASS}`, "aria-expanded": String(all) }, all ? "Show fewer" : `View all ${rows.length}`);
  button.addEventListener("click", () => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    applyLimit(slot, id, rowSelector, limit);
  });
  slot.append(button);
}

/** Make sure a row can be seen: open "View all" for the list it is in, if it is hidden. */
export function reveal(row: HTMLElement, slot: HTMLElement, id: string, rowSelector: string): void {
  const watching = row.closest<HTMLDetailsElement>("details.watching");
  if (watching) watching.open = true;
  if (!row.hidden && !row.closest("[hidden]")) return;
  expanded.add(id);
  applyLimit(slot, id, rowSelector);
}

/** The rows the keyboard walks: those in an open section, not hidden by "View all" or the priority filter. */
export function walkRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)].filter((r) => !r.closest(`[hidden], .${NEED_FILTERED_CLASS}, details:not([open])`));
}

/** Move within the walkable rows, stopping at either end; without a selection, start at the first. */
export function stepRow(rows: readonly HTMLElement[], selected: HTMLElement | undefined, step: 1 | -1): HTMLElement | undefined {
  const i = selected ? rows.indexOf(selected) : -1;
  return rows[Math.max(0, Math.min(rows.length - 1, i + step))];
}

/** The ids the lists use for "View all". */
export const LIMIT_ID = { needs: "needs", agents: "agents", feed: "changes-feed", news: "changes-news", priority: "priority", usage: "usage" } as const;
export const NEED_ROW_SELECTOR = `.${NEED_CLASS}`;

// What each section is filled with.

export const DECISION_LIMIT = 15;

export function fillPeople(home: Home, people: People | undefined, now: number, hooks: PeopleHooks): void {
  home.slots.people.replaceChildren(peopleView(people, now, hooks));
  applyLimit(home.slots.people, "people", ".people-row");
  home.slots.peopleCount.textContent = people ? String(people.rows.length) : "…";
  home.slots.peopleCount.title = people?.warnings.length ? "Partial results; see source warnings" : "Human asks";
}

export function fillNeeds(home: Home, needs: readonly Need[], hooks: NeedsHooks, entries: readonly Entry[] = []): number {
  const slot = home.slots.needs;
  const waiting = waitingCount(needs);
  const limit = Math.max(DECISION_LIMIT, needs.filter((n) => n.action === "answer" && !n.done).length);
  if (needs.length === 0) slot.replaceChildren(h("p", { class: `empty ${CAUGHT_UP_CLASS}` }, DECISIONS_CONFIG.document ? "No other asks. See the decisions document above." : "All caught up: nothing needs you right now."));
  else slot.replaceChildren(needsHead(needs, hooks, slot, limit), ...needs.map((n, i) => {
    const row = needRow(n, hooks);
    row.setAttribute(NEED_ORDER_ATTR, String(i));
    return row;
  }));
  const keys = new Set(needs.map((n) => n.key));
  const identity = (e: Entry): string => {
    const ref = e.pr?.ref ?? e.item?.ref;
    return ref ? refKey(ref).toLowerCase() : e.key;
  };
  const seen = new Set(needs.flatMap((n) => n.entry ? [identity(n.entry)] : n.decision?.item.ref ? [refKey(n.decision.item.ref).toLowerCase()] : []));
  const watching = entries.flatMap((e) => [e, ...(e.children ?? [])]).filter((e) => {
    const key = identity(e);
    if (keys.has(e.key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The rows past the limit, at the priority picked, are moved in by applyPriority, which also counts them in the summary.
  if (watching.length || needs.length > limit) slot.append(h("details", { class: WATCHING_CLASS }, h("summary", {}), ...watching.map((e) => {
    const label = hooks.labelOf(e);
    const state = e.verdict ? VERDICT_LABEL[e.verdict.state] : label?.text ?? "read";
    const reason = e.wait?.onBot ? ON_BOT_LABEL : e.wait?.reasons.length ? e.wait.reasons.map((r) => REASON_LABEL[r]).join(" · ") : rowText(e) || "No concrete ask; read for context.";
    return h("p", { class: WATCHING_ITEM_CLASS }, h("a", { href: e.href }, e.title), ` · ${e.where} `, h("span", { class: `state ${label?.cls ?? "read"}` }, state), h("span", { class: "why" }, ` · ${reason}`));
  })));
  applyPriority(slot, hooks.priority ?? ALL_PRIORITIES, limit);
  setCount(home, "needs", DECISIONS_CONFIG.document ? `document + ${waiting} other asks` : String(waiting), { title: `${waiting} other asks waiting on you`, hot: waiting > 0 });
  return waiting;
}

/**
 * The status writer cuts each item's title to a fixed length ("Cross-check
 * ostreedev/ostre…"); a link to a board item gets the item's full title
 * back, and wraps. Only a cut label the full title starts with is replaced,
 * so a link the writer labelled otherwise keeps its words. The text after
 * the link and "+N more" are the writer's and cannot be recovered here.
 */
function fullTitles(slot: HTMLElement, board: readonly Item[] | undefined): void {
  if (!board) return;
  const titles = new Map(board.flatMap((i) => (i.url ? [[i.url.toLowerCase(), i.title] as const] : [])));
  for (const a of slot.querySelectorAll("a[href]")) {
    const title = titles.get(a.getAttribute("href")!.toLowerCase());
    const cut = /^(.+?)(?:…|\.\.\.)$/s.exec(a.textContent ?? "");
    if (title && cut && title !== a.textContent && title.startsWith(cut[1]!)) a.textContent = title;
  }
}

export function fillStatus(home: Home, status: ProjectStatus | null | undefined, render: Renderer, error?: string, now = Date.now(), board?: readonly Item[]): void {
  const slot = home.slots.status;
  const timestamp = status ? Date.parse(status.createdAt) : NaN;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  const interval = STATUS_INTERVAL;
  const age = () => {
    const el = slot.querySelector<HTMLElement>(".status-age");
    if (!el) return;
    el.textContent = Number.isFinite(timestamp) ? `As of ${clock(timestamp)}, ${minutes} min ago` : "Status age unknown";
    const stale = interval !== undefined && now - timestamp > interval * 60_000;
    el.classList.toggle("hot", stale);
    if (stale) el.append(" · stale");
  };
  age();
  if (status && slot.dataset.signature === JSON.stringify(status)) {
    fullTitles(slot, board);
    return;
  }
  slot.dataset.signature = JSON.stringify(status) ?? "";
  slot.replaceChildren(h("h2", {}, "Status"));
  if (!status) {
    slot.append(h("p", { class: "note" }, error ?? (status === null ? "No project status update yet." : "Reading project status…")));
    return;
  }
  const body = h("div", { class: "md status-preview" }, render(status.body, TRACKER_REPO));
  const paragraph = body.querySelector(":scope > p") ?? body.firstElementChild;
  paragraph?.classList.add("status-summary");
  const button = h("button", { type: "button", class: "small", "aria-expanded": "false" }, "Expand");
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    body.classList.toggle("status-preview", !open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Collapse" : "Expand";
  });
  slot.append(h("p", { class: "note status-age" }), body, button);
  fullTitles(slot, board);
  age();
}

/**
 * What Focus says of an epic in place of its raw Status. Once every
 * sub-issue is closed the epic is ready to close, whatever its Status
 * (often a stale Needs human), so say that and why it is still open: the
 * open asks blocking it, else its Status. A missing Status is not a
 * status but a board bug, flagged as one.
 */
export function focusStatus(epic: Item, board: readonly Item[]): { text: string; bug: boolean } {
  const bug = !epic.status;
  const status = epic.status ? `Status ${epic.status}` : "no Status on the board";
  const s = epic.subIssues;
  if (!s || s.total === 0 || s.completed < s.total) return { text: epic.status ?? "No Status on the board", bug };
  const key = epic.ref ? refKey(epic.ref).toLowerCase() : undefined;
  const blocks = (i: Item) => {
    const ref = blockedBy(i);
    return ref !== undefined && refKey(ref).toLowerCase() === key;
  };
  const asks = key ? board.filter((i) => i.state === "open" && blocks(i)).length : 0;
  const why = asks ? `${asks} open ask${asks === 1 ? "" : "s"}${bug ? `; ${status}` : ""}` : status;
  return { text: `Ready to close; still open: ${why}`, bug };
}

/** Active epics, with GitHub's progress and their running child work. */
export function fillFocus(home: Home, board: readonly Item[] | undefined): void {
  const slot = home.slots.focus;
  slot.replaceChildren(h("h2", {}, "Focus"));
  if (!board) {
    slot.append(h("p", { class: "note" }, "Reading active epics…"));
    return;
  }
  const live = (i: Item) => i.state !== "closed" && i.state !== "merged" && i.status !== "Done";
  const epics = board.filter((i) => live(i) && (i.labels.includes("epic") || i.subIssues) && i.status !== "Todo" && i.status !== "Draft").sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title));
  for (const epic of epics) {
    const paused = epic.status === "Paused" || epic.verdict?.toLowerCase() === "park";
    const status = focusStatus(epic, board);
    const row = h("article", { class: `focus-epic${paused ? " paused" : ""}` }, h("h3", {}, epic.priority ? `${epic.priority} · ` : "", h("a", { href: epic.url ?? "#" }, epic.title)), h("p", {}, epic.subIssues ? `${epic.subIssues.completed}/${epic.subIssues.total} complete` : "Progress not reported", " · ", h("span", { class: `focus-status${status.bug ? " state bug" : ""}` }, status.text)));
    if (epic.subIssues) row.append(h("progress", { max: String(epic.subIssues.total), value: String(epic.subIssues.completed), "aria-label": `${epic.title} progress` }));
    const children = board.filter((i) => live(i) && i.status === "In Progress" && i.parent && epic.ref && refKey(i.parent).toLowerCase() === refKey(epic.ref).toLowerCase());
    row.append(h("ul", {}, ...children.map((i) => h("li", {}, h("a", { href: i.url ?? "#" }, i.title), i.lead ? ` · ${i.lead}` : "", " · running"))));
    slot.append(row);
  }
  if (!epics.length) slot.append(h("p", { class: "note" }, "No active epics."));
}

export function fillAgents(home: Home, active: Active | undefined, now: number, summary?: AgentSummary): void {
  const slot = home.slots.agents;
  slot.replaceChildren(agentsBody(active, now, summary));
  applyLimit(slot, LIMIT_ID.agents, ".as-agent");
  const s = agentsSummary(active, now, summary);
  setCount(home, "agents", s.count, { title: s.title });
  home.sections.agents.count.classList.toggle("under", s.under);
}

/** The ops detail; returns its element, whose live times main.ts keeps ticking. */
export function fillOps(home: Home, ops: Ops | undefined, now: number): HTMLElement {
  const el = opsDetail(ops, now);
  // Keep pasted evidence only while the same completed job is shown.
  // Reuse its nodes rather than persisting private logs or retaining them
  // across navigation/sign-out. A new run deliberately starts unknown.
  const previous = [...home.slots.ops.querySelectorAll<HTMLElement>(".ctl-output")];
  for (const output of el.querySelectorAll<HTMLElement>(".ctl-output")) {
    const old = previous.find(p => p.dataset.run && p.dataset.run === output.dataset.run);
    if (old) output.replaceWith(old);
  }
  home.slots.ops.replaceChildren(el);
  return el;
}

export interface ChangesData {
  board?: readonly Item[] | undefined;
  seen: Snapshot | undefined;
  fromCache: boolean;
  news: News | undefined;
  feed: Pick<FeedOptions, "urgentOnly" | "onUrgentOnly" | "onSeen">;
}

export function fillChanges(home: Home, data: ChangesData, render: Renderer, now: number): void {
  home.slots.feed.replaceChildren(feedSection(data.board, data.seen, { ...data.feed, now, ...(data.fromCache ? { fromCache: true } : {}) }));
  applyLimit(home.slots.feed, LIMIT_ID.feed, ".feed-row");
  home.slots.news.replaceChildren(newsList(data.news, render, now));
  applyLimit(home.slots.news, LIMIT_ID.news, ".news-item");
  const changed = data.board && data.seen && !data.fromCache ? diffBoard(data.seen, data.board).length : undefined;
  setCount(home, "changes", changed === undefined ? "—" : String(changed), { title: changed === undefined ? "board changes since you last looked: not known yet" : `${changed} items changed on the board since you last looked`, hot: changed !== undefined && changed > 0 });
}

export function fillPriority(home: Home, entries: readonly Entry[], labelOf: (e: Entry) => RowLabel | undefined, now: number, filter: QueueFilter, extras: ListExtras): void {
  const slot = home.slots.priority;
  slot.replaceChildren(priorityList(entries, labelOf, now, filter, extras));
  applyLimit(slot, LIMIT_ID.priority, ".row");
  const rows = entries.reduce((n, e) => n + 1 + (e.children?.length ?? 0), 0);
  setCount(home, "priority", String(rows), { title: `${rows} rows in the queue, ranked by priority` });
}

export function fillThemes(home: Home, board: OpenBoard | undefined, filter: TriageFilter, hooks: TriageHooks): void {
  home.slots.themes.replaceChildren(triageView(board, filter, hooks));
}

export function fillUsage(home: Home, usage: UsageData | undefined, hb: Heartbeat | null | undefined, now: number): void {
  // A redraw rebuilds the rows: keep the pool expanders he opened as they were.
  const pools = () => [...home.slots.weekly.querySelectorAll<HTMLDetailsElement>(`details[${POOL_ATTR}]`)];
  const open = new Set(pools().filter((d) => d.open).map((d) => d.getAttribute(POOL_ATTR)));
  home.slots.weekly.replaceChildren(weeklyUsage(usage, now));
  for (const d of pools()) d.open = open.has(d.getAttribute(POOL_ATTR));
  const slot = home.slots.usage;
  const body = usageSection(usage, hb, now);
  slot.replaceChildren(body ?? h("p", { class: "note" }, "Reading…"));
  applyLimit(slot, LIMIT_ID.usage, ".uc");
  setCount(home, "usage", usageSummary(usage));
}
