// Entry point: sign-in, routing between the one page of sections, board
// items and forge PRs, keyboard commands, and polling while the tab is
// visible.

import type { Answer } from "../answer.ts";
import { h } from "../dom.ts";
import { pageState, type PageState } from "./state.ts";
import { loadActionRuns, runsDue, type RunsData } from "./runs.ts";
import { readSource, type Sources } from "./freshness.ts";
import { createRenderer } from "../markdown.ts";
import { GitHub, GitHubError } from "./api.ts";
import { missingScopes, type Persistence, savedToken, type TokenSource, useToken } from "./auth.ts";
import { itemAction, reviewAskFor, reviewComment, type RunRef } from "./asks.ts";
import type { Item } from "./board.ts";
import {
  type Context,
  loadAnswered,
  loadContext,
  loadDecisions,
  loadOpenBoard,
  loadQueue,
  loadRuns,
  type OpenBoard,
  postAnswer,
  postAskComment,
  rerunFailedJobs,
  rerunPrRun,
  submitAskedReview,
  viewer,
} from "./backend.ts";
import {
  decideAdvance,
  EDITED_ATTR,
  type Origin,
  overlayVerdicts,
  overlayWaiting,
  type PendingVerdict,
  pickNext,
  queueStops,
  stillReviewed,
  triageStops,
  writingElsewhere,
} from "./advance.ts";
import { loadSeen, loadUrgentOnly, saveSeen, saveUrgentOnly, type Snapshot, snapshotOf } from "./boardfeed.ts";
import { cachedLabel, type CacheSession, forgetCache, openCache } from "./cache.ts";
import { fileCapture, loadCaptureEpics, loadCaptureLabels, loadLinkTitle } from "./capture.ts";
import { type CaptureBar, captureBar, forgetDraft } from "./captureview.ts";
import { chatPanel, type ChatPanel } from "./chat.ts";
import { DecisionsRefresh } from "./decisionsrefresh.ts";
import { DECISIONS_CONFIG, refreshDocument } from "./decisiondocument.ts";
import {
  CLASSIC_SCOPES,
  DONE_NOTICE_MS,
  FETCH_CONCURRENCY,
  FORGE_MIN_INTERVAL_MS,
  FORGE_POLL_INTERVAL_MS,
  NEWS_LIMIT,
  OPERATOR,
  OPS_POLL_INTERVAL_MS,
  POLL_BACKOFF_FACTOR,
  POLL_INTERVAL_MS,
  POLL_SLOW_MS,
  POLL_STALL_MS,
  RATE_LOW_FRACTION,
  THEME_KEY,
} from "./config.ts";
import { composeReviews, type ForgePr, refKey, type ReviewAction, VERDICT_LABEL } from "./forge.ts";
import type { QueueFilter } from "./filter.ts";
import { type Command, HELP, keyCommand, parseRoute, type Route, type RouteInfo } from "./keys.ts";
import { type HarnessCache, loadNews, type News } from "./news.ts";
import { deleteCacheDatabase, IdbStore } from "./idbstore.ts";
import type { Active } from "./agents.ts";
import { fillAgents, fillChanges, fillFocus, fillStatus, fillNeeds, fillOps, fillPeople, fillPriority, fillState, fillSummary, fillThemes, fillUsage, type Home, type HomeHooks, homeSkeleton, LIMIT_ID, NEED_ROW_SELECTOR, reveal, setSectionOpen, stepRow, walkRows } from "./homeview.ts";
import { ACTION_CONFIG } from "./actions.ts";
import { actionsPanel } from "./actionsview.ts";
import { REVIEW_DRAFT_CONFIG } from "./reviewdrafts.ts";
import { reviewDraftsPanel } from "./reviewdraftsview.ts";
import { loadProjectStatus } from "./backend.ts";
import { botWaitingCount, filterNeeds, type Need, needStops } from "./needs.ts";
import { needId, type NeedsForm, type NeedsHooks, needsRedraw, needsSignature } from "./needsview.ts";
import { activeFromOps, type JobCache, loadActive, loadOps, type Ops } from "./ops.ts";
import { tickOps } from "./opsview.ts";
import { Poller, pollDelay, pollNote } from "./poller.ts";
import { saveMine } from "./mine.ts";
import { MINE_CLASS } from "./mineview.ts";
import { loadPeople, markPeopleDone, type People } from "./people.ts";
import { peopleMeta } from "./peopleview.ts";
import {
  loadFileLines,
  loadForgePrs,
  loadOtherPrs,
  loadPrDetail,
  loadRangeFiles,
  loadWaiting,
  mapLimit,
  type OtherPr,
  type PrDetail,
  refreshVerdicts,
  searchBotPrs,
  submitReview,
  type VerdictEntry,
  type WaitingPr,
  type WaitingRead,
} from "./prs.ts";
import { APPROVE_ACTION, canReview, type PrPane, prView, REVIEW_FORM_CLASS, type ReviewAskInfo } from "./prview.ts";
import { buildEntries, type Entry, itemHref, onBot, staleItems } from "./queue.ts";
import { isSection, loadSectionPrefs, type SectionId, type SectionPrefs, saveSectionPref, sectionOpen } from "./sections.ts";
import { loadAdvance, loadFilter, loadNeedsPriority, saveAdvance, saveFilter, saveNeedsPriority } from "./store.ts";
import { buildTriage, type Decision, decisionLabel, parseDecision, sortDecisions, triageOrder, type TriageFilter } from "./triage.ts";
import { answerState, type BoardHref, clock, type ContextHooks, CONTEXT_CLASS, contextView, itemView, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, type RowLabel, STATE_LABEL, tickAges } from "./view.ts";
import { ON_BOT_LABEL, REASON_LABEL } from "./waiting.ts";

const render = createRenderer(window);

interface State {
  people?: People;
  peopleRunning?: boolean;
  peopleRevision?: number;
  peopleWrites?: number;
  actionRuns?: RunsData;
  runsStarted: number;
  runsRunning: boolean;
  sources: Sources;
  gh: GitHub;
  source: TokenSource;
  session: CacheSession;
  /** Set once signed out: nothing renders any more. */
  closed: boolean;
  /** Set once GitHub rejected the token; see rejected(). */
  rejecting?: Promise<void>;
  login?: string;
  items: Item[];
  /** In Review items, which only rank the PRs in their Branch. */
  linked: Item[];
  loaded: boolean;
  /** The bot's open draft PRs on the forge, from the last search. */
  prs: ForgePr[];
  /** The bot's open PRs other than the forge's drafts, from the last searches. */
  others: OtherPr[];
  /** Those of them the queue lists, and why, from the last read. */
  waiting: WaitingPr[];
  /** Their reads that only a change to the PR moves, for the next read to reuse (see loadWaiting). */
  waitingReads: Map<string, WaitingRead>;
  /** Their verdicts and heads, by refKey. */
  verdicts: Map<string, VerdictEntry>;
  lastForgePoll: number;
  /** Search the forge on the next poll if the minimum interval allows. */
  forceForge: boolean;
  /** Whether a forge search has succeeded, so missing forge PRs mean gone. */
  forgeKnown: boolean;
  /** The queue's filter: the hash's, else the last chosen (remembered if storage allows). */
  filter: QueueFilter;
  verdictsRunning: boolean;
  waitingRunning: boolean;
  poller: Poller;
  /** The ranked queue. */
  entries: Entry[];
  /** The row the keyboard is on: its section and key (see rowId). */
  selected: string | undefined;
  /** Items answered from this tab, until the bot moves them on. */
  sent: Set<string>;
  /** Run URLs whose rerun request is in flight. */
  rerunning: Set<string>;
  /** Runs rerun from this tab ("<chore node id> <run url>"), so a chore with several knows when each went out. */
  rerunsSent: Set<string>;
  /** Open questions he has answered on GitHub and the bot hasn't acted on, by node id. */
  answered: Set<string>;
  /** Bumped per board change, so an older answered read can't land over a newer one. */
  answeredSeq: number;
  /** PRs reviewed from this tab, by refKey, with the head reviewed (see stillReviewed). */
  reviewed: Map<string, string>;
  /** Those reviews' verdicts, shown until GitHub's reads agree (see overlayVerdicts); by refKey. */
  pending: Map<string, PendingVerdict>;
  /** Context of opened items, by node id. */
  context: Map<string, Context>;
  /** Loaded PR details, by refKey. */
  details: Map<string, PrDetail>;
  /** The search's updated_at a PR was last reloaded for, by refKey. */
  reloadedFor: Map<string, string>;
  /** The open item as it was rendered, to notice changes under it. */
  shown?: { nodeId: string; key: string };
  /** The open PR as it was rendered: its key, updated_at, and what the queue listed it for (JSON). */
  shownPr?: { key: string; updatedAt: string; wait: string | undefined };
  /** A note about the open item or PR, e.g. that it changed. */
  itemNote?: string;
  /** The changes section's merged PRs, as last read, and which of them touched the harness. */
  news?: News;
  harness: HarnessCache;
  /** The ops detail's last read, when it started, and the finished runs' jobs. */
  ops?: Ops;
  opsStarted: number;
  opsRunning: boolean;
  /** What the agents, changes and usage sections show: the board, the heartbeat and the usage as last read (or the ops detail's), and when that started. */
  active?: Active;
  activeStarted: number;
  activeRunning: boolean;
  jobs: JobCache;
  /** Moves the ops detail's live times while it is shown. */
  ticker?: ReturnType<typeof setInterval>;
  /** The page's sections, while it is shown, and which of them he opened or closed. */
  home?: Home;
  prefs: SectionPrefs;
  /** The rows of "Needs you" as last drawn, and a signature of them. */
  needs: Need[];
  /** The priority those rows are filtered by. */
  needsPriority: string;
  /** Why GitHub hasn't confirmed `login` (it is then the cache's, or unknown); retried at each poll. */
  loginError?: string;
  loginChecking?: boolean;
  needsSig?: string;
  /** Keys of questions answered from the page: kept in the list, dimmed, until a reload. */
  answeredHere: Set<string>;
  /** The verdict filter of the themes under "By priority". */
  triageFilter: TriageFilter;
  /** The open PR's pane, which handles its own keys. */
  pane?: PrPane;
  /** The capture bar, shown to OPERATOR only. */
  capture?: CaptureBar;
  chat?: ChatPanel | undefined;
  help: boolean;
  /** The location hash last routed to. */
  hash: string;
  /** The section the open entry was opened from: "needs", "priority" or "themes". */
  openedFrom: "needs" | "priority" | "themes";
  /** The list the open entry was opened from, which an action there moves on in. */
  origin?: Origin;
  /** Whether an action opens the next entry (a setting, on by default). */
  advance: boolean;
  /** Where the app moved to after an action, while its "Done" notice shows. */
  doneAt?: string;
  doneTimer?: ReturnType<typeof setTimeout>;
  lastPoll?: Date;
  /** The queue shows cached data fetched at this time (epoch ms), until the board is revalidated. */
  cachedAt?: number;
  /** PR details shown from the cache, by refKey: when they were fetched. */
  prCachedAt: Map<string, number>;
  /** The changes section shows cached merged PRs fetched at this time. */
  newsCachedAt?: number;
  /** The themes' last read of the open board, and when a cached copy was fetched. */
  openBoard?: OpenBoard;
  openBoardCachedAt?: number;
  /** Themes whose group is open under "By priority". */
  triageOpen: Set<string>;
  /** The open decisions, in order, and when a cached copy was fetched. */
  decisions?: Decision[];
  decisionsCachedAt?: number;
  decisionsRefresh?: DecisionsRefresh<DecisionsRead, DecisionsRead & { at: number }>;
  /** Decisions he answered (on GitHub, or from this tab until the next read) and the bot hasn't acted on, by issue node id. */
  decisionsAnswered: Set<string>;
  error?: string;
  forgeError?: string;
  /** What the token lacks, e.g. classic scopes. */
  tokenWarning?: string;
  /** Keeps the header's ages and poll note current between polls. */
  metaTicker?: ReturnType<typeof setInterval>;
  /** When the ticker last ran: a gap means the page was frozen (see frozenSince). */
  tickedAt: number;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html lacks #${id}`);
  return el as T;
}

/** Re-render the header this often, so "cached · N min ago" and the poll note don't freeze. */
const META_TICK_MS = 15_000;

/** When the header's ticker last ran, if it has since missed two of its turns: the page was frozen from then. */
function frozenSince(state: State): number | undefined {
  return Date.now() - state.tickedAt > 2 * META_TICK_MS ? state.tickedAt : undefined;
}

/** Set once GitHub rejected the token: late loads mustn't draw over the sign-in page. */
let viewClosed = false;

/**
 * A chat still attached when GitHub rejected the token. It doesn't use the
 * token, and closing it would end the session run, so it stays up and the
 * next sign-in takes it over.
 */
let keptChat: ChatPanel | undefined;

function showMain(node: Node): void {
  if (viewClosed) return;
  byId("view").replaceChildren(node);
}

function setNotice(text: string | undefined): void {
  const n = byId("notice");
  n.textContent = text ?? "";
  n.hidden = !text;
}

const route = (): RouteInfo => parseRoute(window.location.hash);

function routeItemId(): string | undefined {
  const r = route();
  return r.route === "item" ? r.id : undefined;
}

/** What the open item view shows; a change means the view is stale. */
function itemKey(item: Item): string {
  return JSON.stringify([item.title, item.why, item.body, item.priority, item.status]);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** When what the current view shows was fetched, if it is a cached copy not yet revalidated. */
function cachedSince(state: State): number | undefined {
  const r = route();
  if (r.route === "pr") return state.prCachedAt.get(refKey(r.ref));
  return state.cachedAt;
}

/**
 * The header's meta line. Who is signed in and the rate budget are
 * also put in the controls menu, where a narrow screen shows them
 * instead (see style.css), keeping only how fresh the data is in view.
 */
function renderMeta(state: State): void {
  const parts: Node[] = [];
  const part = (cls: string, ...children: (string | Node)[]) => parts.push(h("span", { class: `mp ${cls}` }, ...children));
  const who = state.login ? `signed in as ${state.login}` : undefined;
  const api = state.gh.rate ? `API ${state.gh.rate.remaining}/${state.gh.rate.limit}` : undefined;
  if (who) part("mp-who", who);
  // From what waits now, not state.needs (the rows drawn), which stays behind while a redraw is deferred under a half-written answer.
  const botCount = botWaitingCount(currentNeeds(state));
  const people = peopleMeta(state.people, !!state.home?.el.isConnected && !!state.home.el.querySelector<HTMLDetailsElement>("#sec-people")?.open);
  part("mp-queues", h("span", { title: people.title }, people.text), ` · bot ${botCount}`);
  const since = cachedSince(state);
  if (since !== undefined) part("mp-age", h("span", { class: "cached", title: "Shown from this browser's cache; checking GitHub for changes" }, cachedLabel(since, Date.now())));
  else if (state.lastPoll) part("mp-age", `checked ${clock(state.lastPoll.getTime())}`);
  // Why it isn't being refreshed as usual, if it isn't. Only the queue's
  // cached copy (also shown behind an item) is re-read by the poll itself;
  // PRs have loaders of their own.
  const r = route().route;
  const note = pollNote(state.poller.status(), Date.now(), POLL_SLOW_MS, since !== undefined && r !== "pr");
  if (note) part("mp-note", h("span", { class: "cached", title: "Not refreshing from GitHub as usual" }, note));
  if (api) part("mp-api", api);
  byId("meta").replaceChildren(...parts);
  byId("menu-meta").textContent = [who, api].filter(Boolean).join(" · ");
}

/** Meta line and notices only: never touches the view, or a half-typed answer. */
function renderChrome(state: State): void {
  if (state.closed) return;
  renderMeta(state);
  const json = document.getElementById("state-json");
  const model = snapshot(state);
  if (json) json.textContent = JSON.stringify(model, null, 2);
  if (state.home?.el.isConnected) {
    fillState(state.home, model);
    fillSummary(state.home, model, state.ops?.controller, Date.now());
    const signature = JSON.stringify(model.agents);
    if (state.home.slots.agents.dataset.signature !== signature) {
      fillAgents(state.home, state.active, Date.now(), model.agents);
      state.home.slots.agents.dataset.signature = signature;
    }
  }
  const r = route().route;
  const warnings = [state.error, state.forgeError, state.tokenWarning, state.itemNote];
  if (state.login && state.login !== OPERATOR) {
    warnings.push(`You are signed in as ${state.login}; the bot acts only on answers and reviews from ${OPERATOR}.`);
  }
  if (state.help) warnings.push(`Keys: ${HELP[r]}`);
  setNotice(warnings.filter(Boolean).join(" ") || undefined);
}

function labelOf(state: State): (e: Entry) => RowLabel | undefined {
  return (e) => {
    if (e.kind === "pr") {
      if (e.pr && state.reviewed.has(refKey(e.pr.ref))) return { text: "reviewed from here", cls: "answered" };
      if (onBot(e)) return { text: ON_BOT_LABEL, cls: "on-bot" };
      if (e.wait?.reasons.length) return { text: e.wait.reasons.map((r) => REASON_LABEL[r]).join(" · "), cls: "w-yours" };
      const v = e.verdict;
      if (!v) return { text: "checking reviews…", cls: "pending" };
      return v.state === "none" ? undefined : { text: VERDICT_LABEL[v.state], cls: `v-${v.state}` };
    }
    const st = e.item ? answerState(e.item, state.sent, state.answered) : undefined;
    return st ? { text: STATE_LABEL[st], cls: st } : undefined;
  };
}

/** Link issues that are in the queue to their item view. */
function boardHref(state: State): BoardHref {
  return (ref) => {
    const key = refKey(ref).toLowerCase();
    const item = state.items.find((i) => i.ref && refKey(i.ref).toLowerCase() === key);
    return item ? itemHref(item) : undefined;
  };
}

/** A row's identity across sections: the same entry can be listed in "Needs you" and under "By priority". */
const rowId = (el: Element): string => `${el.getAttribute(ROW_SECTION_ATTR) ?? ""}|${el.getAttribute(ROW_KEY_ATTR) ?? ""}`;

/** The rows the keyboard walks: those in an open section, not hidden by "View all". */
function rows(): HTMLElement[] {
  return walkRows(byId("view"));
}

/** Mark the selected row, defaulting to the first. */
function markSelected(state: State, scroll: boolean): void {
  const all = rows();
  const sel = all.find((r) => rowId(r) === state.selected) ?? all[0];
  for (const r of all) {
    r.classList.toggle("sel", r === sel);
    if (r === sel) r.setAttribute("aria-current", "true");
    else r.removeAttribute("aria-current");
  }
  state.selected = sel ? rowId(sel) : undefined;
  if (scroll && sel) {
    sel.scrollIntoView?.({ block: "nearest" });
    sel.focus({ preventScroll: true });
  }
}

/** The page's section hooks: its default open state, what opening one starts, and what is remembered. */
function homeHooks(state: State): HomeHooks {
  return {
    open: (id) => sectionOpen(id, state.prefs, id === "agents" || id === "needs"),
    toggled: (id, open) => {
      state.prefs[id] = open;
      saveSectionPref(id, open);
      if (open) loadSections(state);
    },
    opsToggled: (open) => {
      if (open) void refreshOps(state);
      else clearInterval(state.ticker);
    },
    themesToggled: (open) => {
      if (open) void refreshTriage(state);
    },
    peopleToggled: (open) => {
      renderChrome(state);
      if (open) void refreshPeople(state);
    },
  };
}

/** The page, built once and kept while it is shown: its sections are filled in place. */
function mountHome(state: State): Home {
  if (state.home?.el.isConnected) return state.home;
  state.home = homeSkeleton(homeHooks(state));
  if (ACTION_CONFIG) state.home.el.prepend(actionsPanel(state.gh, ACTION_CONFIG));
  if (REVIEW_DRAFT_CONFIG) state.home.el.prepend(reviewDraftsPanel(state.gh, REVIEW_DRAFT_CONFIG, render));
  showMain(state.home.el);
  return state.home;
}

function renderHome(state: State): void {
  // A filter in the hash is chosen, and remembered; a bare # shows the last one.
  const r = route();
  if (r.route === "home" && r.filter) {
    state.filter = r.filter;
    saveFilter(r.filter);
  }
  // Drawn once while the page stays: a redraw of it must not take half-typed answers away.
  const fresh = !state.home?.el.isConnected;
  const home = mountHome(state);
  if (r.route === "home" && r.filter) setSectionOpen(home, "priority", true, true, homeHooks(state));
  paintNeeds(state, fresh);
  paintPeople(state);
  paintPriority(state);
  paintActive(state);
  paintChanges(state);
  paintOps(state);
  paintThemes(state);
  markSelected(state, false);
  loadSections(state);
}

/** What the "Needs you" rows act through. */
function needsHooks(state: State, now: number): NeedsHooks {
  return {
    login: state.login,
    loginError: state.loginError,
    checkLogin: () => void confirmLogin(state),
    priority: state.needsPriority,
    pickPriority: (priority) => {
      state.needsPriority = priority;
      saveNeedsPriority(priority);
      markSelected(state, false);
    },
    now,
    render,
    labelOf: labelOf(state),
    send: (need, answer) => sendNeed(state, need, answer),
  };
}

function currentNeeds(state: State): Need[] {
  return snapshot(state).people.filter((need) => DECISIONS_CONFIG.legacyQuestions || need.action !== "answer");
}

function snapshot(state: State): PageState {
  return pageState({ active: state.active, entries: state.entries, decisions: state.decisions, decisionsAnswered: state.decisionsAnswered, answeredHere: state.answeredHere, runs: state.actionRuns, sources: state.sources });
}

function actionRunsDue(state: State): boolean {
  return !state.closed && runsDue(state.runsStarted, state.runsRunning, Date.now(), !document.hidden, route().route === "home" && window.location.hash !== "#state.json");
}

async function refreshActionRuns(state: State): Promise<void> {
  if (state.closed || state.runsRunning || document.hidden || route().route !== "home" || window.location.hash === "#state.json") return;
  state.runsRunning = true;
  state.runsStarted = Date.now();
  try {
    const runs = await loadActionRuns(state.gh);
    if (state.closed) return;
    state.sources.runs = { state: runs.state, checkedAt: runs.at, ...(runs.state === "ok" ? { fetchedAt: runs.at } : { error: runs.warnings.join(" ") }) };
    // Preserve last known rows on a transient failure, while marking them stale.
    if (runs.state === "ok" || !state.actionRuns) state.actionRuns = runs;
    renderChrome(state);
  } finally {
    state.runsRunning = false;
  }
}

/**
 * Redraw "Needs you" if what it lists changed. With an answer half
 * written, only say so, unless `force` (he asked to reload, or the page
 * is being drawn).
 */
function paintNeeds(state: State, force = false): void {
  const home = state.home;
  if (!home || state.closed) return;
  const needs = currentNeeds(state);
  const hooks = needsHooks(state, Date.now());
  const sig = needsSignature(needs, hooks, state.entries);
  const forms: NeedsForm[] = [...home.slots.needs.querySelectorAll("form.answer")].map((form) => ({
    sent: form.hasAttribute("data-sent"),
    text: form.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
    picked: form.querySelector("input[type=radio]:checked") !== null,
  }));
  const policy = needsRedraw({ signature: sig, previousSignature: state.needsSig, forms, note: state.itemNote, force });
  if (policy.action === "skip") return;
  if (policy.note === undefined) delete state.itemNote;
  else state.itemNote = policy.note;
  if (policy.action === "defer") {
    renderChrome(state);
    return;
  }
  state.needs = needs;
  state.needsSig = sig;
  // A redraw keeps him on the row he is on (e.g. the one he moved on to).
  const on = document.activeElement?.closest(".need")?.id;
  fillNeeds(home, needs, hooks, state.entries);
  // The dashboard starts open unless he chose to collapse it.
  if (state.prefs.needs === undefined) setSectionOpen(home, "needs", true, false, homeHooks(state));
  if (on) document.getElementById(on)?.focus({ preventScroll: true });
  markSelected(state, false);
  renderChrome(state);
}

function paintPriority(state: State): void {
  if (!state.home) return;
  fillPriority(state.home, state.entries, labelOf(state), Date.now(), state.filter, { stale: staleItems(state.items, state.entries) });
  markSelected(state, false);
}

function paintPeople(state: State): void {
  if (!state.home || state.closed) return;
  fillPeople(state.home, state.people, Date.now(), {
    done: async (id) => {
      state.peopleWrites = (state.peopleWrites ?? 0) + 1;
      state.peopleRevision = (state.peopleRevision ?? 0) + 1;
      try {
        await markPeopleDone(state.gh, id);
      } finally {
        state.peopleWrites!--;
        state.peopleRevision = (state.peopleRevision ?? 0) + 1;
      }
    },
    changed: () => { paintPeople(state); renderChrome(state); },
  });
}

async function refreshPeople(state: State): Promise<void> {
  if (!state.home?.el.querySelector<HTMLDetailsElement>("#sec-people")?.open) return;
  if (state.peopleRunning || state.peopleWrites || state.closed) return;
  state.peopleRunning = true;
  const revision = state.peopleRevision;
  try {
    const people = await readSource(state.sources, "people", (gh) => loadPeople(gh, Date.now(), state.login === OPERATOR), state.gh);
    if (state.closed) return;
    if (!people || revision !== state.peopleRevision) { renderChrome(state); return; }
    state.people = people;
    paintPeople(state);
    renderChrome(state);
  } finally {
    state.peopleRunning = false;
  }
}

/** Where the themes under "By priority" open an item in the app: only one in the queue; others open on GitHub. */
function triageItemHref(state: State, item: Item): string | undefined {
  return state.items.some((i) => i.nodeId === item.nodeId) ? itemHref(item) : undefined;
}

function paintThemes(state: State): void {
  if (!state.home) return;
  fillThemes(state.home, state.openBoard, state.triageFilter, {
    itemHref: (item) => triageItemHref(state, item),
    open: state.triageOpen,
    toggled: (theme, open) => {
      if (open) state.triageOpen.add(theme);
      else state.triageOpen.delete(theme);
    },
    setFilter: (f) => {
      state.triageFilter = f;
      paintThemes(state);
    },
  });
}

/**
 * The changes feed's snapshot. The first time the board is read (not
 * from the cache), it becomes what the feed starts from.
 */
function feedSeen(board: readonly Item[] | undefined, at: number, fromCache: boolean | undefined): Snapshot | undefined {
  let seen = loadSeen();
  if (!seen && board && !fromCache) {
    seen = snapshotOf(board, at);
    saveSeen(seen);
  }
  return seen;
}

function paintActive(state: State): void {
  if (!state.home) return;
  const model = snapshot(state);
  fillAgents(state.home, state.active, Date.now(), model.agents);
  fillStatus(state.home, state.active?.status === undefined ? undefined : model.status, render, state.active?.statusError, Date.now(), state.active?.board);
  fillFocus(state.home, state.active?.board ? model.focus : undefined);
  fillUsage(state.home, model.usage ?? undefined, state.active?.local, Date.now());
  fillState(state.home, model);
  fillSummary(state.home, model, state.ops?.controller, Date.now());
}

function paintChanges(state: State): void {
  if (!state.home) return;
  const a = state.active;
  fillChanges(
    state.home,
    {
      board: a?.board,
      seen: feedSeen(a?.board, a?.at ?? Date.now(), a?.fromCache),
      fromCache: a?.fromCache === true,
      news: state.news,
      feed: {
        urgentOnly: loadUrgentOnly(),
        onUrgentOnly: (on) => {
          saveUrgentOnly(on);
          paintChanges(state);
        },
        onSeen: () => {
          if (state.active?.board) saveSeen(snapshotOf(state.active.board, state.active.at));
          paintChanges(state);
        },
      },
    },
    render,
    Date.now(),
  );
}

function paintOps(state: State): void {
  if (!state.home) return;
  const el = fillOps(state.home, state.ops, Date.now());
  clearInterval(state.ticker);
  if (state.home.slots.opsBox.open) {
    state.ticker = setInterval(() => {
      if (!document.hidden) tickOps(el, Date.now());
    }, 1000);
  }
}

function sectionOpenNow(state: State, id: SectionId): boolean {
  return state.home?.sections[id].details.open === true;
}

function activeDue(state: State): boolean {
  return !state.activeRunning && Date.now() - state.activeStarted >= OPS_POLL_INTERVAL_MS;
}

/**
 * Start the reads the open sections show: the agents' and usage's
 * (always, they are cheap and fill their counts), the merged PRs while
 * the changes are open, the ops detail and the themes while their folds
 * are, and the decisions, which are rows of "Needs you".
 */
function loadSections(state: State): void {
  if (state.closed || !state.loaded || route().route !== "home" || !state.home) return;
  if (activeDue(state)) void refreshActive(state);
  if (actionRunsDue(state)) void refreshActionRuns(state);
  if (sectionOpenNow(state, "changes") && !state.news) void refreshNews(state);
  if (state.home.slots.opsBox.open && opsDue(state)) void refreshOps(state);
  if (state.home.slots.themesBox.open && !state.openBoard) void refreshTriage(state);
  if (!state.decisions) void refreshDecisions(state);
  if (!state.people) void refreshPeople(state);
}

/**
 * Re-read the board, heartbeat and usage, as often as the ops detail,
 * and only while the page shows. The first time, what the cache has
 * shows first.
 */
async function refreshActive(state: State): Promise<void> {
  if (state.activeRunning) return;
  state.activeRunning = true;
  state.activeStarted = Date.now();
  try {
    if (!state.active) {
      const cached = state.gh.cacheOnly();
      const active = await loadActive(cached);
      if (!state.active && (active.board || active.local !== undefined || active.usage)) {
        active.at = cached.oldest ?? active.at;
        active.fromCache = true;
        state.active = active;
        paintActive(state);
        paintChanges(state);
      }
    }
    const [active, status] = await Promise.all([loadActive(state.gh), readSource(state.sources, "status", () => loadProjectStatus(state.gh))]);
    state.active = active;
    if (status !== undefined) state.active.status = status;
    else state.active.statusError = state.sources.status?.error ?? "Status unavailable";
    paintActive(state);
    paintNeeds(state);
    paintChanges(state);
  } finally {
    state.activeRunning = false;
  }
}

/** The item `#item/<id>` opens: a board item, or a decision's issue that is not on the board. */
function routedItem(state: State, id: string): Item | undefined {
  return [...state.items, ...(state.active?.board ?? []), ...(state.decisions?.map((d) => d.item) ?? [])].find((i) => i.nodeId === id);
}

/** Rebuild the whole view for the current route. */
function renderRoute(state: State): void {
  if (state.closed) return;
  delete state.shown;
  delete state.shownPr;
  delete state.itemNote;
  state.pane?.dispose();
  delete state.pane;
  clearInterval(state.ticker);
  delete state.ticker;
  renderChrome(state);
  if (!state.loaded) {
    showMain(h("p", { class: "empty" }, "Loading…"));
    return;
  }
  if (window.location.hash === "#state.json") {
    showMain(h("main", { class: "state-export" }, h("a", { href: "#", class: "back" }, "← Back"), h("h2", {}, "state.json"), h("pre", { id: "state-json" }, JSON.stringify(snapshot(state), null, 2))));
    return;
  }
  const r = route();
  if (r.route === "pr") {
    renderPr(state, r.ref);
    return;
  }
  if (r.route === "home") {
    renderHome(state);
    return;
  }
  const item = r.route === "item" ? routedItem(state, r.id) : undefined;
  if (!item) {
    if (r.route === "item") setNotice("That item no longer needs you (or isn't on the board).");
    renderHome(state);
    return;
  }
  const ctx = state.context.get(item.nodeId);
  state.shown = { nodeId: item.nodeId, key: itemKey(item) };
  const answered = ctx?.answered ? new Set([...state.answered, item.nodeId]) : state.answered;
  const entry = state.entries.find((e) => e.item?.nodeId === item.nodeId);
  const asks = entry?.children ?? [];
  const action = itemAction(item, asks.filter((a) => a.item?.state !== "closed").length);
  const hash = window.location.hash;
  const done = (url: string) => {
    const from = byId("view").querySelector("form.answer");
    state.sent.add(item.nodeId);
    state.context.delete(item.nodeId);
    void refreshContext(state, item);
    acted(state, { key: `item:${item.nodeId}`, title: item.title, hash, from });
    return url;
  };
  showMain(
    itemView(
      item,
      { action, context: ctx, state: answerState(item, state.sent, answered), asks, hooks: contextHooks(state, item), labelOf: labelOf(state) },
      render,
      {
        send: async (answer) => {
          if (action.kind !== "answer") throw new Error("this is not a question");
          return done((await postAnswer(state.gh, action.ref, answer)).url);
        },
        comment: async (text) => {
          if (action.kind !== "review" && action.kind !== "rerun" && action.kind !== "comment") throw new Error("this is not a review or chore");
          const kind = action.kind === "comment" ? action.ask : action.kind === "review" ? "review" : "chore";
          return done((await postAskComment(state.gh, action.ref, kind, text)).url);
        },
        rerun: (url) => rerun(state, item, url),
      },
    ),
  );
  if (!ctx) void refreshContext(state, item);
}

/**
 * Rerun a rerun chore's run, as its view asks; one request per run at a
 * time, so a re-rendered view can't send a second while one is in flight.
 */
async function rerun(state: State, item: Item, url: string): Promise<string> {
  const action = itemAction(item, 0);
  if (action.kind !== "rerun") throw new Error("this chore asks for no reruns");
  if (state.rerunning.has(url)) throw new Error("a rerun of this run is already in flight");
  state.rerunning.add(url);
  const hash = window.location.hash;
  // Taken now: a board change or another rerun can drop the context meanwhile.
  const runs = state.context.get(item.nodeId)?.runs ?? [];
  const sentKey = (u: string) => `${item.nodeId} ${u}`;
  try {
    const posted = await rerunFailedJobs(state.gh, action.ref, url);
    state.rerunsSent.add(sentKey(url));
    // A chore can list several runs: it is done once each that can be rerun was.
    const left = runs.some((r) => r.problem === undefined && !state.rerunsSent.has(sentKey(r.run.url)));
    if (!left) state.sent.add(item.nodeId);
    state.context.delete(item.nodeId);
    void refreshContext(state, item);
    acted(state, { key: `item:${item.nodeId}`, title: item.title, hash, from: null, ...(left ? { stillWaiting: true } : {}) });
    return posted.url;
  } finally {
    state.rerunning.delete(url);
  }
}

/** Rerun a listed PR's failed required check run, one request per run at a time. */
async function rerunPr(state: State, ref: { owner: string; repo: string; number: number }, url: string, allowed: readonly RunRef[]): Promise<string> {
  if (state.rerunning.has(url)) throw new Error("a rerun of this run is already in flight");
  state.rerunning.add(url);
  try {
    const out = await rerunPrRun(state.gh, ref, url, allowed);
    state.forceForge = true;
    return out;
  } finally {
    state.rerunning.delete(url);
  }
}

/** What an item's loaded context acts through. */
function contextHooks(state: State, item: Item): ContextHooks {
  return { boardHref: boardHref(state), rerun: (url) => rerun(state, item, url), rerunning: (url) => state.rerunning.has(url) };
}

function prEntry(state: State, key: string): Entry | undefined {
  const want = `pr:${key}`.toLowerCase();
  return state.entries.find((e) => e.key.toLowerCase() === want);
}

function renderPr(state: State, ref: { owner: string; repo: string; number: number }): void {
  const key = refKey(ref);
  const detail = state.details.get(key);
  if (!detail) {
    showMain(h("main", { class: "item" }, h("a", { href: "#", class: "back" }, "← Back (u)"), h("p", { class: "empty" }, `Loading ${key}…`)));
    void loadPr(state, ref, true);
    return;
  }
  // Opening a PR the forge says changed since we read it reads it again,
  // once per search result, in case the two timestamps never agree. (A
  // cached copy is being re-read already.)
  const searched = [...state.prs, ...state.others.map((o) => o.pr)].find((p) => refKey(p.ref) === key)?.updatedAt;
  if (searched && detail.updatedAt && searched > detail.updatedAt && !state.prCachedAt.has(key) && state.reloadedFor.get(key) !== searched) {
    state.reloadedFor.set(key, searched);
    state.details.delete(key);
    renderPr(state, ref);
    return;
  }
  state.shownPr = { key, updatedAt: detail.updatedAt, wait: JSON.stringify(prEntry(state, key)?.wait) };
  const found = reviewAskFor(state.items, ref);
  const ask: ReviewAskInfo | undefined = found && {
    pr: found.target.ref,
    issue: found.ref,
    head: found.target.head,
    ...(found.item.url ? { issueUrl: found.item.url } : {}),
    ...(found.body.ask ? { text: found.body.ask } : {}),
  };
  const entry = prEntry(state, key);
  const runs = entry?.wait?.reasons.includes("rerun") ? (entry.wait.runs ?? []) : [];
  const reruns = runs.length
    ? {
        load: () => loadRuns(state.gh, runs, detail.url),
        hooks: { rerun: (url: string) => rerunPr(state, ref, url, runs), rerunning: (url: string) => state.rerunning.has(url) },
      }
    : undefined;
  const hash = window.location.hash;
  const pane = prView(detail, entry, render, {
    review: async (action, text, draft, comments, sent) => {
      const reviews = composeReviews(action, text, detail.head, { draft, comments });
      const onSent = (i: number) => sent(reviews[i]?.commit_id ?? "");
      // A PR outside the bot's own space is reviewable only because of its
      // ask: re-read that before writing, not just the board's snapshot.
      const url =
        found && !canReview(detail)
          ? await submitAskedReview(state.gh, found.ref, ref, found.target.head, reviews, onSent)
          : await submitReview(state.gh, ref, reviews, onSent);
      state.reviewed.set(key, detail.head);
      // Show its effect now: search and the reviews API lag a write.
      const verdict = REVIEW_VERDICT[action];
      if (verdict) {
        state.pending.set(key, { state: verdict, head: detail.head, at: Date.now() });
        // Read its reviews again on the next poll, even before search notices.
        state.verdicts.delete(key);
        // A PR listed for what waits on him has no verdict overlay: apply the review to its wait (and again after each read).
        state.waiting = overlayWaiting(state.waiting, state.pending, Date.now());
      }
      // Tell the bot on its review ask. The review went out either way.
      const note = found ? reviewComment(action, ref, detail.head, url) : undefined;
      if (found && note) {
        // Answered as far as the queue goes, before the comment lands.
        state.sent.add(found.item.nodeId);
        postAskComment(state.gh, found.ref, "review", note).catch((e: unknown) => {
          // Not answered after all: the ask is listed again.
          state.sent.delete(found.item.nodeId);
          rebuildEntries(state);
          update(state, false, false);
          state.error = `Your review went out, but the comment telling the bot on ${refKey(found.ref)} didn't: ${message(e)}. Comment there yourself.`;
          renderChrome(state);
        });
      }
      const from = byId("view").querySelector(`form.${REVIEW_FORM_CLASS}`);
      acted(state, { key: `pr:${key}`, title: detail.title, hash, from });
      void refetchPr(state, ref, from, false);
      return url;
    },
    loadRange: (base, to) => loadRangeFiles(state.gh, ref, base, to),
    loadLines: (path, sha) => loadFileLines(state.gh, ref, path, sha),
    mine: {
      login: state.login,
      scopes: () => state.gh.scopes,
      save: async (edit, committer, { promote, ownText }, progress) => {
        const r = await saveMine(state.gh, detail, edit, { committer, ownText, promote, scopes: state.gh.scopes, progress });
        // The head, title and body changed: the queue and this PR need a fresh read.
        state.details.delete(key);
        const from = byId("view").querySelector(`.${MINE_CLASS}`);
        acted(state, { key: `pr:${key}`, title: detail.title, hash, from });
        void refetchPr(state, ref, from, true);
        return r;
      },
    },
  }, { reviewedHere: state.reviewed.has(key), ...(ask ? { ask } : {}), ...(reruns ? { reruns } : {}) });
  state.pane = pane;
  showMain(pane.el);
}

/** The verdict a review of his gives the PR; a comment-only one leaves it waiting on him. */
const REVIEW_VERDICT: Record<ReviewAction, "approved" | "changes-requested" | undefined> = {
  approve: "approved",
  "request-changes": "changes-requested",
  comment: undefined,
};

/**
 * Re-read a PR after an action on it. With `redraw` (its head changed),
 * show it again if it is still open, unless he is writing on its page
 * (other than in `from`, whose text went out): the next poll's note then
 * offers the reload. Without, a page he stayed on keeps its review
 * status, expanded diffs and place.
 */
async function refetchPr(state: State, ref: { owner: string; repo: string; number: number }, from: Element | null, redraw: boolean): Promise<void> {
  const key = refKey(ref);
  let fresh: PrDetail;
  try {
    fresh = await loadPrDetail(state.gh, ref);
  } catch {
    // The next open reloads it.
    return;
  }
  state.details.set(key, fresh);
  state.prCachedAt.delete(key);
  const r = route();
  if (state.closed || r.route !== "pr" || refKey(r.ref) !== key) return;
  if (!redraw || writingElsewhere(byId("view"), from, document.activeElement)) {
    // Our own write moved updated_at: don't report it as a change.
    if (state.shownPr?.key === key) state.shownPr.updatedAt = fresh.updatedAt;
    return;
  }
  renderRoute(state);
}

/** What an action was done on, for acted(). */
interface Done {
  /** The entry's key in the queue, e.g. `pr:owner/repo#n` or `item:PVTI_...`. */
  key: string;
  title: string;
  /** The location hash of the view it was done on. */
  hash: string;
  /** The part of that view whose text went out with it, if any. */
  from: Element | null;
  /** The entry still waits on him whatever the queue says, e.g. a chore with runs left to rerun. */
  stillWaiting?: boolean;
  /** The list to step through, when not the one the entry was opened from (a view acting in place). */
  origin?: Origin;
  /** Move on to a next stop that is answered in place by focusing it, by key, instead of changing the hash. */
  focus?: (key: string) => void;
}

/** "" and "#" are both the bare page. */
const sameHash = (a: string, b: string) => a.replace(/^#$/, "") === b.replace(/^#$/, "");

/** The "By priority" list, as the list an entry was opened from. */
function queueOrigin(state: State, hash: string): Origin {
  const filter = state.filter;
  return { hash, stops: queueStops(state.entries, filter), live: () => queueStops(state.entries, filter) };
}

/**
 * After an action succeeded (the caller has applied what it knows of its
 * effect to the state): rebuild the queue with that effect, re-read the
 * board and the forge now rather than at the next poll, and move on to
 * the next entry of the list he came from, if the setting is on, the
 * entry no longer waits on him, he is still on its view and he isn't
 * writing something else there. The list is "Needs you" unless he opened
 * the entry from "By priority" or the themes under it.
 */
function acted(state: State, done: Done): void {
  if (state.closed) return;
  rebuildEntries(state);
  // Its own effect isn't news to the page it was done on.
  if (state.shownPr && done.key === `pr:${state.shownPr.key}`) state.shownPr.wait = JSON.stringify(prEntry(state, state.shownPr.key)?.wait);
  refreshSoon(state);
  const origin = done.origin ?? state.origin ?? needsOrigin(state, "#");
  const live = origin.live();
  const next = pickNext(origin.stops, done.key, live);
  const decision = decideAdvance(
    {
      enabled: state.advance,
      ok: true,
      stillThere: sameHash(window.location.hash, done.hash),
      writing: writingElsewhere(byId("view"), done.from, document.activeElement),
      stillWaiting: done.stillWaiting ?? live.some((s) => s.key === done.key && s.waiting),
    },
    next,
  );
  switch (decision.kind) {
    case "go":
      if (done.focus && decision.to.inPlace) {
        showDone(state, `Done: ${done.title} → ${decision.to.title}`);
        done.focus(decision.to.key);
      } else moveOn(state, decision.to.href, `Done: ${done.title} → ${decision.to.title}`, done.hash);
      return;
    case "caught-up":
      if (done.focus) showDone(state, `Done: ${done.title}. All caught up.`);
      else moveOn(state, origin.hash, `Done: ${done.title}. All caught up.`, done.hash);
      return;
    case "stay":
      showDone(state, decision.why === "writing" ? `Done: ${done.title}. Staying here: you have unsent text on this page.` : `Done: ${done.title}.`);
      // Show the effect wherever he is, without touching an open form.
      update(state, false, false);
      return;
  }
}

/** Go to `hash` after an action, with a notice saying so and a link back to where it was done. */
function moveOn(state: State, hash: string, text: string, back: string): void {
  showDone(state, text, back);
  state.doneAt = hash;
  if (sameHash(window.location.hash, hash)) renderRoute(state);
  else window.location.hash = hash;
}

/** The small "Done: …" notice, with an optional link back. */
function showDone(state: State, text: string, back?: string): void {
  const el = byId("done");
  el.replaceChildren(text, ...(back !== undefined ? [" · ", h("a", { href: back || "#" }, "back")] : []));
  el.hidden = false;
  clearTimeout(state.doneTimer);
  state.doneTimer = setTimeout(() => hideDone(state), DONE_NOTICE_MS);
}

function hideDone(state: State): void {
  clearTimeout(state.doneTimer);
  delete state.doneAt;
  byId("done").hidden = true;
}

/**
 * Load (or reload) a PR's details, then show them if it is still open.
 * With `cacheFirst`, a cached copy is shown first, marked as such, and
 * replaced only if the fresh one differs. Approving from it is safe:
 * submitReview checks the head against GitHub, never the cache.
 */
async function loadPr(state: State, ref: { owner: string; repo: string; number: number }, cacheFirst = false): Promise<void> {
  const key = refKey(ref);
  const isOpen = () => {
    const r = route();
    return !state.closed && r.route === "pr" && refKey(r.ref) === key;
  };
  if (cacheFirst && !state.details.has(key)) {
    const cached = state.gh.cacheOnly();
    try {
      const detail = await loadPrDetail(cached, ref);
      if (!state.details.has(key)) {
        state.details.set(key, detail);
        state.prCachedAt.set(key, cached.oldest ?? Date.now());
        if (isOpen()) renderRoute(state);
      }
    } catch {
      // Not (all) cached: wait for GitHub.
    }
  }
  let fresh: PrDetail;
  try {
    fresh = await loadPrDetail(state.gh, ref);
  } catch (e) {
    if (!isOpen()) return;
    if (state.prCachedAt.has(key)) {
      state.itemNote = `Couldn't refresh ${key}: ${message(e)}. This is the cached copy; press r to retry.`;
      renderChrome(state);
      return;
    }
    showMain(
      h(
        "main",
        { class: "item" },
        h("a", { href: "#", class: "back" }, "← Back (u)"),
        h("p", { class: "warn" }, `Couldn't load ${key}: ${message(e)}. Press r to retry.`),
      ),
    );
    return;
  }
  const shown = state.details.get(key);
  const wasCached = state.prCachedAt.delete(key);
  state.details.set(key, fresh);
  if (!isOpen()) return;
  // The cached copy was right: keep the pane (and where he scrolled to).
  if (wasCached && shown && JSON.stringify(shown) === JSON.stringify(fresh)) renderChrome(state);
  else renderRoute(state);
}

/** (Re)load an item's context and update only that part of its view. */
async function refreshContext(state: State, item: Item): Promise<void> {
  const ctx = await loadContext(state.gh, item);
  state.context.set(item.nodeId, ctx);
  if (routeItemId() !== item.nodeId) return;
  const container = byId("view").querySelector(`.${CONTEXT_CLASS}`);
  container?.replaceChildren(contextView(item, ctx, render, contextHooks(state, item)));
}

/**
 * Re-read the merged PRs (conditionally), and show them if the changes
 * section is on the page and they changed. The first time, a complete
 * cached copy shows first.
 */
async function refreshNews(state: State): Promise<void> {
  if (!state.news) {
    const cached = state.gh.cacheOnly();
    const news = await loadNews(cached, state.harness, NEWS_LIMIT).catch(() => undefined);
    // Only a complete copy: a repository missing from the cache would read as an error.
    if (news && !news.warnings.length && !state.news) {
      state.news = news;
      state.newsCachedAt = cached.oldest ?? Date.now();
      paintChanges(state);
      renderChrome(state);
    }
  }
  try {
    const news = await loadNews(state.gh, state.harness, NEWS_LIMIT);
    const first = !state.news;
    delete state.newsCachedAt;
    state.news = news;
    if (news.changed || first) paintChanges(state);
    renderChrome(state);
  } catch (e) {
    state.error = `Couldn't read the merged PRs: ${message(e)}`;
    renderChrome(state);
  }
}

/**
 * Re-read every open board item (conditionally) for the themes under
 * "By priority", and show them if they changed. The first time, a
 * cached copy shows first.
 */
async function refreshTriage(state: State): Promise<void> {
  if (!state.openBoard) {
    const cached = state.gh.cacheOnly();
    const board = await loadOpenBoard(cached).catch(() => undefined);
    if (board && !state.openBoard) {
      state.openBoard = board;
      state.openBoardCachedAt = cached.oldest ?? Date.now();
      paintThemes(state);
      renderChrome(state);
    }
  }
  try {
    const board = await loadOpenBoard(state.gh);
    const redraw = board.changed || state.openBoardCachedAt !== undefined || !state.openBoard;
    delete state.openBoardCachedAt;
    state.openBoard = board;
    if (redraw) paintThemes(state);
    renderChrome(state);
  } catch (e) {
    state.error = `Couldn't read the board for the themes: ${message(e)}`;
    renderChrome(state);
  }
}

/**
 * Answer a row of "Needs you" in place: post the comment as him, mark
 * the row done until the page reloads, and move on to the next row.
 */
async function sendNeed(state: State, need: Need, answer: Answer): Promise<string> {
  const item = need.decision?.item ?? need.entry?.item;
  if (!item?.ref) throw new Error("this question has no issue to answer on");
  const hash = window.location.hash;
  const posted = await postAnswer(state.gh, item.ref, answer);
  // The next read confirms it: his comment is now after the bot's last.
  if (need.entry?.item) {
    state.sent.add(need.entry.item.nodeId);
    state.context.delete(need.entry.item.nodeId);
  }
  if (need.decision) state.decisionsAnswered.add(need.decision.item.nodeId);
  state.answeredHere.add(need.key);
  const title = need.decision ? `${decisionLabel(need.decision)}: ${need.title}` : need.title;
  acted(state, {
    key: need.key,
    title,
    hash,
    from: document.getElementById(needId(need))?.querySelector("form.answer") ?? null,
    origin: needsOrigin(state, hash),
    focus: (key) => focusRow(state, "needs", key),
  });
  return posted.url;
}

/** Move to the row of `section` with stop key `key`, opening "View all" if it is hidden. */
function focusRow(state: State, section: string, key: string): void {
  const row = allRows().find((r) => r.getAttribute(ROW_SECTION_ATTR) === section && r.getAttribute(ROW_KEY_ATTR) === key);
  if (!row || !state.home) return;
  reveal(row, state.home.slots.needs, LIMIT_ID.needs, NEED_ROW_SELECTOR);
  row.scrollIntoView?.({ block: "start" });
  // The row, not a field in it: the single-key shortcuts keep working.
  row.focus({ preventScroll: true });
  state.selected = rowId(row);
  markSelected(state, false);
}

/** Every row on the page, shown or not. */
function allRows(): HTMLElement[] {
  return [...byId("view").querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)];
}

/** "Needs you" as a list to step through: questions are answered in place, the rest open. */
function needsOrigin(state: State, hash: string): Origin {
  // Moving on after an answer stays within the rows the priority filter shows.
  const shown = (needs: readonly Need[]) => needStops(filterNeeds(needs, state.needsPriority));
  return { hash, stops: shown(state.needs), live: () => shown(currentNeeds(state)) };
}

/** The themes under "By priority" as a list to step through: their rows that open in the app, in their order. */
function themesOrigin(state: State, hash: string): Origin {
  const filter = state.triageFilter;
  const stops = () =>
    triageStops(state.openBoard ? triageOrder(buildTriage(state.openBoard.items, filter)) : [], state.entries, {
      opens: (i) => triageItemHref(state, i),
      settled: (i) => state.sent.has(i.nodeId) || state.answered.has(i.nodeId),
    });
  return { hash, stops: stops(), live: stops };
}

interface DecisionsRead {
  decisions: Decision[];
  answered: Set<string>;
}

/**
 * Re-read the open decisions and which he answered, and show them among
 * the rows of "Needs you" if they changed; with an answer half written,
 * only say so, unless `force` (he asked to reload).
 */
async function refreshDecisions(state: State, force = false): Promise<void> {
  if (state.home) await refreshDocument(state.gh, state.home.slots.decisionDocument, render, DECISIONS_CONFIG.document, force);
  if (!DECISIONS_CONFIG.legacyQuestions) return;
  const read = async (gh: GitHub) => {
    const q = await loadDecisions(gh);
    const answered = await loadAnswered(gh, q.items);
    return { changed: q.changed, decisions: sortDecisions(q.items.map(parseDecision)), answered };
  };
  state.decisionsRefresh ??= new DecisionsRefresh({
    closed: () => state.closed,
    hasValue: () => state.decisions !== undefined,
    cached: async () => {
      const cached = state.gh.cacheOnly();
      const r = await read(cached);
      return { ...r, at: cached.oldest ?? Date.now() };
    },
    read: () => read(state.gh),
    applyCached: (r) => {
      state.sources.decisions = { state: "cached", fetchedAt: r.at };
      state.decisions = r.decisions;
      state.decisionsAnswered = r.answered;
      state.decisionsCachedAt = r.at;
      paintNeeds(state);
    },
    applyLive: (r, force) => {
      state.sources.decisions = { state: "ok", checkedAt: Date.now(), fetchedAt: Date.now() };
      delete state.decisionsCachedAt;
      state.decisions = r.decisions;
      state.decisionsAnswered = r.answered;
      paintNeeds(state, force);
    },
    error: (e) => {
      state.sources.decisions = { ...state.sources.decisions, state: "unavailable", checkedAt: Date.now(), error: message(e) };
      state.error = `Couldn't read the decisions: ${message(e)}`;
      renderChrome(state);
    },
  });
  await state.decisionsRefresh.refresh(force);
}

function opsDue(state: State): boolean {
  return !state.opsRunning && Date.now() - state.opsStarted >= OPS_POLL_INTERVAL_MS;
}

/**
 * Re-read the ops detail's data, and show it if its fold is open. The
 * first time, what the cache has shows first, marked as cached:
 * sections it lacks say so rather than warn.
 */
async function refreshOps(state: State): Promise<void> {
  if (state.opsRunning) return;
  state.opsRunning = true;
  state.opsStarted = Date.now();
  try {
    if (!state.ops) {
      const cached = state.gh.cacheOnly();
      const ops = await loadOps(cached, state.jobs);
      if (!state.ops && (ops.devspaces || ops.work || ops.events)) {
        ops.at = cached.oldest ?? ops.at;
        ops.fromCache = true;
        state.ops = ops;
        paintOps(state);
      }
    }
    state.ops = await loadOps(state.gh, state.jobs);
    // The same reads serve the agents, changes and usage sections, so they needn't repeat them.
    state.active = activeFromOps(state.active, state.ops);
    state.activeStarted = Date.now();
    paintOps(state);
    paintActive(state);
    paintChanges(state);
  } finally {
    state.opsRunning = false;
  }
}

/** Re-search the forge when due; true if its list of PRs changed. Verdicts follow in the background. */
async function pollForge(state: State): Promise<boolean> {
  const wait = state.forceForge ? FORGE_MIN_INTERVAL_MS : FORGE_POLL_INTERVAL_MS;
  if (Date.now() - state.lastForgePoll < wait) return false;
  state.forceForge = false;
  try {
    // One search of the bot's PRs serves both lists. Settled apart: a failed
    // search of the requests keeps the other PRs as they were, and the drafts still refresh.
    const all = await searchBotPrs(state.gh);
    const [forge, others] = await Promise.allSettled([loadForgePrs(state.gh, all), loadOtherPrs(state.gh, all)]);
    if (forge.status === "rejected") throw forge.reason;
    const prs = forge.value;
    state.lastForgePoll = Date.now();
    state.sources.forge = { state: "ok", checkedAt: Date.now(), fetchedAt: Date.now() };
    state.forgeKnown = true;
    delete state.forgeError;
    const sig = (p: readonly ForgePr[]) => JSON.stringify(p.map((x) => [refKey(x.ref), x.updatedAt]));
    const changed = sig(prs) !== sig(state.prs);
    state.prs = prs;
    void pollVerdicts(state);
    if (others.status === "fulfilled") {
      state.sources.otherPrs = { state: "ok", checkedAt: Date.now(), fetchedAt: Date.now() };
      state.others = others.value;
      void pollWaiting(state);
    } else {
      state.sources.otherPrs = { state: "unavailable", checkedAt: Date.now(), error: message(others.reason) };
      state.forgeError = `Couldn't search the bot's other PRs: ${message(others.reason)}`;
    }
    return changed;
  } catch (e) {
    state.forgeError = `Couldn't search the bot's PRs: ${message(e)}`;
    state.sources.forge = { ...state.sources.forge, state: "unavailable", checkedAt: Date.now(), error: message(e) };
    // The same search serves the other PRs: they weren't refreshed either.
    state.sources.otherPrs = { ...state.sources.otherPrs, state: "unavailable", checkedAt: Date.now(), error: message(e) };
    return false;
  }
}

/** Whose turn each PR other than a forge draft is, re-read every forge poll (check runs move without the PR; the rest only when it moved); update the view if that changed. */
async function pollWaiting(state: State): Promise<void> {
  if (state.waitingRunning) return;
  state.waitingRunning = true;
  try {
    // A PR reviewed from here is read afresh until its review stops applying, as search may lag it.
    const known = new Map([...state.waitingReads].filter(([k]) => !state.pending.has(k)));
    const { prs: read, errors, failed, reads } = await loadWaiting(state.gh, state.others, known);
    state.waitingReads = reads;
    // A PR that couldn't be read this time keeps its last standing rather than flicker out;
    // one reviewed from here keeps the review's effect over a read that started before it or lags it.
    const prs = overlayWaiting([...read, ...state.waiting.filter((w) => failed.has(refKey(w.pr.ref)))], state.pending, Date.now());
    const sig = (w: readonly WaitingPr[]) => JSON.stringify(w.map((x) => [refKey(x.pr.ref), x.pr.title, x.pr.body, x.pr.draft, x.head, x.wait, x.verdict]));
    const changed = sig(prs) !== sig(state.waiting);
    state.waiting = prs;
    if (errors.length) {
      state.sources.otherPrs = { ...state.sources.otherPrs, state: "unavailable", checkedAt: Date.now(), error: errors.join("; ") };
      state.forgeError = `Couldn't read ${errors.length} of the bot's PRs: ${errors.join("; ")}`;
      renderChrome(state);
    }
    if (changed && state.loaded) update(state, false, false);
  } finally {
    state.waitingRunning = false;
  }
}

/** Re-read the verdicts of PRs that changed, and update the view if any moved. */
async function pollVerdicts(state: State): Promise<void> {
  // One at a time; the next forge poll catches up on what this one missed.
  if (state.verdictsRunning) return;
  state.verdictsRunning = true;
  try {
    const verdicts = await refreshVerdicts(state.gh, state.prs, state.verdicts);
    // Until a read confirms his review from here, read its PR again every
    // time: search may have moved on while the reviews API still lagged.
    for (const k of state.pending.keys()) {
      const v = verdicts.get(k);
      if (v) verdicts.set(k, { ...v, updatedAt: "" });
    }
    const sig = (v: ReadonlyMap<string, VerdictEntry>) => JSON.stringify([...v].map(([k, e]) => [k, e.head, e.verdict.state, e.botReplied === true]).sort());
    const changed = sig(verdicts) !== sig(state.verdicts);
    state.verdicts = verdicts;
    if (changed && state.loaded) update(state, false, false);
  } catch (e) {
    state.forgeError = `Couldn't read the forge PRs' reviews: ${message(e)}`;
    state.sources.forge = { ...state.sources.forge, state: "unavailable", checkedAt: Date.now(), error: message(e) };
    renderChrome(state);
  } finally {
    state.verdictsRunning = false;
  }
}

/**
 * Show the queue as the cache last saw it, before GitHub answers: the
 * board, the forge's PRs and their verdicts, and which questions are
 * answered, all read by the same loaders from a cache-only client, so
 * the first render already has its labels and nothing shifts when the
 * fresh answer replaces it. Does nothing if the board isn't cached or
 * the network was faster.
 */
async function showCached(state: State): Promise<void> {
  // The label's age is the board's and the search's: verdicts of PRs
  // that haven't changed are reused without re-reading them.
  const queueReads = state.gh.cacheOnly();
  const otherReads = state.gh.cacheOnly();
  let items: Item[];
  let linked: Item[];
  try {
    ({ items, linked } = await loadQueue(queueReads));
  } catch {
    return;
  }
  const all = await searchBotPrs(queueReads).catch(() => undefined);
  const prs = all && (await loadForgePrs(queueReads, all));
  const others = all && (await loadOtherPrs(queueReads, all).catch(() => undefined));
  const waiting = others ? (await loadWaiting(otherReads, others)).prs : [];
  const verdicts = new Map<string, VerdictEntry>();
  const parts = await mapLimit(prs ?? [], FETCH_CONCURRENCY, (p) => refreshVerdicts(otherReads, [p], new Map()).catch(() => new Map<string, VerdictEntry>()));
  for (const part of parts) for (const [k, v] of part) verdicts.set(k, v);
  const answered = await loadAnswered(otherReads, items);
  if (state.loaded || state.closed) return;
  state.items = items;
  state.linked = linked;
  if (prs) {
    state.prs = prs;
    state.forgeKnown = true;
  }
  if (others) {
    state.others = others;
    state.waiting = waiting;
  }
  state.verdicts = verdicts;
  state.answered = answered;
  state.loaded = true;
  state.cachedAt = queueReads.oldest ?? Date.now();
  state.sources.queue = { state: "cached", fetchedAt: state.cachedAt };
  update(state, true, true);
}

/**
 * Re-read which questions he answered, after the queue is on screen (one
 * request per open question with comments, so it shouldn't hold up the
 * first render), and update the view if that changed.
 */
async function refreshAnswered(state: State, items: readonly Item[]): Promise<void> {
  const seq = ++state.answeredSeq;
  const answered = await loadAnswered(state.gh, items);
  if (seq !== state.answeredSeq) return;
  const same = answered.size === state.answered.size && [...answered].every((id) => state.answered.has(id));
  state.answered = answered;
  if (!same) update(state, false, false);
}

function rebuildEntries(state: State): void {
  const { verdicts, pending } = overlayVerdicts(state.verdicts, state.pending, Date.now());
  state.pending = pending;
  state.reviewed = stillReviewed(state.reviewed, (key) => [
    state.verdicts.get(key)?.head,
    state.waiting.find((w) => refKey(w.pr.ref) === key)?.head,
    state.details.get(key)?.head,
  ]);
  const replied = new Set([...state.verdicts].filter(([, v]) => v.botReplied).map(([k]) => k));
  state.entries = buildEntries(state.items, state.prs, verdicts, state.forgeKnown, new Set([...state.answered, ...state.sent]), {
    others: state.waiting,
    replied,
    linked: state.linked,
  });
}

/**
 * Rebuild the queue after new data, and refresh the view without losing
 * a half-typed answer or review: only the page's lists are redrawn, and
 * "Needs you" not at all while he is writing in it; an open item or PR
 * just gets a note if it changed underneath.
 */
function update(state: State, boardChanged: boolean, first: boolean): void {
  if (state.closed) return;
  rebuildEntries(state);
  const r = route();
  if (first) {
    renderRoute(state);
  } else if (r.route === "home") {
    // The page stays as it is; only the lists that follow the queue are redrawn.
    if (state.home?.el.isConnected) {
      paintNeeds(state);
      paintPriority(state);
    } else renderRoute(state);
  } else if (r.route === "item") {
    const item = routedItem(state, r.id);
    if (!item) state.itemNote = "This item no longer needs you; the bot may have acted on it.";
    else if (state.shown && itemKey(item) !== state.shown.key) {
      state.itemNote = "This item changed on the board since you opened it; go back and reopen it to see the new version.";
    }
    if (item && boardChanged) void refreshContext(state, item);
    renderChrome(state);
  } else if (r.route === "pr") {
    const key = refKey(r.ref);
    // The pane was built for what the queue listed it for (review form, re-sign, reruns).
    if (state.shownPr?.key === key && JSON.stringify(prEntry(state, key)?.wait) !== state.shownPr.wait) {
      state.itemNote = "The queue now lists this PR for something else (a review, re-sign or rerun); press r to reload.";
    }
    const now = [...state.prs, ...state.others.map((o) => o.pr)].find((p) => refKey(p.ref) === key)?.updatedAt;
    if (state.shownPr?.key === key && now && state.shownPr.updatedAt && now > state.shownPr.updatedAt) {
      state.itemNote = "This PR changed since you opened it (new commits or reviews); press r to reload.";
    }
    renderChrome(state);
  }
}

/** What the poll re-reads for the page: the open sections' data, and the decisions. */
function pollSections(state: State): void {
  if (route().route !== "home" || !state.home || !state.loaded) return;
  if (activeDue(state)) void refreshActive(state);
  if (actionRunsDue(state)) void refreshActionRuns(state);
  if (sectionOpenNow(state, "changes")) void refreshNews(state);
  if (state.home.slots.opsBox.open && opsDue(state)) void refreshOps(state);
  if (state.home.slots.themesBox.open) void refreshTriage(state);
  void refreshDecisions(state);
  void refreshPeople(state);
}

/**
 * Ask GitHub whose token this is, after the read at start failed: until
 * it answers, the rows can't say who is answering, and the capture bar
 * stays away. A 401 signs out through the client's onUnauthorized.
 */
async function confirmLogin(state: State): Promise<void> {
  if (state.closed || state.loginChecking || state.loginError === undefined) return;
  state.loginChecking = true;
  try {
    state.login = await viewer(state.gh);
    delete state.loginError;
    // Persisting is a convenience: failing at it doesn't unconfirm the login.
    if (state.session.store) await state.session.cache.attach(state.session.store, state.login, state.session.tokenHash).catch(() => false);
    if (state.closed) return;
    if (state.login === OPERATOR && !state.capture) showCapture(state);
  } catch (e) {
    state.loginError = message(e);
  } finally {
    state.loginChecking = false;
  }
  if (!state.closed) paintNeeds(state);
}

/**
 * One poll; state.poller runs them one at a time and schedules the next.
 * One it gave up on (no longer `current`) drops what it reads late.
 */
async function poll(state: State, current: () => boolean): Promise<void> {
  if (state.closed) return;
  void confirmLogin(state);
  pollSections(state);
  // The board and the forge load side by side; whichever answers first shows first.
  const forge = pollForge(state);
  try {
    const q = await loadQueue(state.gh);
    if (!current()) return;
    state.lastPoll = new Date();
    state.sources.queue = { state: "ok", checkedAt: Date.now(), fetchedAt: Date.now() };
    delete state.error;
    const first = !state.loaded;
    // The first answer after showing the cached queue: re-read what the
    // cache decided (which questions are answered) even if the board is unchanged.
    const revalidated = state.cachedAt !== undefined;
    delete state.cachedAt;
    if (q.changed || first || revalidated) {
      state.items = q.items;
      state.linked = q.linked;
      // Keep "sent" only for items still waiting on the bot.
      const ids = new Set(q.items.map((i) => i.nodeId));
      for (const s of state.sent) if (!ids.has(s)) state.sent.delete(s);
      state.context.clear();
      state.loaded = true;
      update(state, true, first);
      refreshAnswered(state, q.items).catch((e: unknown) => {
        // The answered labels stay as they were; the next board change retries.
        console.error("review: couldn't update which questions are answered:", e);
      });
    } else {
      renderChrome(state);
    }
  } catch (e) {
    if (!current()) return;
    state.error = `Couldn't read the board: ${message(e)}`;
    state.sources.queue = { ...state.sources.queue, state: "unavailable", checkedAt: Date.now(), error: message(e) };
    if (state.loaded) renderChrome(state);
    else renderRoute(state);
  }
  if ((await forge) && current() && state.loaded) update(state, false, false);
}

/** Re-read the board and the forge now, not at the next poll: an action changed them. */
function refreshSoon(state: State): void {
  state.forceForge = true;
  state.poller.now();
}

/** The poll loop of the state `get` returns (a getter: the state holds the loop). */
function newPoller(get: () => State): Poller {
  return new Poller({
    run: (current) => poll(get(), current),
    delay: () => pollDelay(get().gh.rate, Date.now(), { interval: POLL_INTERVAL_MS, backoff: POLL_BACKOFF_FACTOR, lowFraction: RATE_LOW_FRACTION, clock }, get().gh.blockedUntil),
    hidden: () => document.hidden,
    changed: () => {
      if (get().loaded) renderChrome(get());
    },
    abort: (before) => get().gh.abandonGets(before),
    stallMs: POLL_STALL_MS,
  });
}

function isEditing(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function run(state: State, cmd: Command, where: Route): void {
  const view = byId("view");
  if (where === "pr" && state.pane?.command(cmd)) return;
  switch (cmd) {
    case "next":
    case "prev": {
      const step = cmd === "next" ? 1 : -1;
      const all = rows();
      const next = stepRow(all, all.find((r) => rowId(r) === state.selected), step);
      state.selected = next ? rowId(next) : undefined;
      markSelected(state, true);
      return;
    }
    case "open": {
      const sel = rows().find((r) => r.classList.contains("sel"));
      if (!sel) return;
      state.openedFrom = openedFrom(sel);
      window.location.hash = sel.getAttribute("href") ?? sel.getAttribute(ROW_HREF_ATTR) ?? "#";
      return;
    }
    case "back":
      window.location.hash = "#";
      return;
    case "refresh": {
      const r = route();
      if (r.route === "pr") {
        void loadPr(state, r.ref);
        return;
      }
      if (r.route === "home") {
        // The sections' data is re-read too, now rather than when due; a reload on request drops the needs rows' unsent picks, as the note warned (the decisions document keeps its own).
        state.activeStarted = 0;
        state.opsStarted = 0;
        state.runsStarted = 0;
        void refreshActionRuns(state);
        void refreshDecisions(state, true);
        void refreshPeople(state);
        if (sectionOpenNow(state, "changes")) void refreshNews(state);
        if (state.home?.slots.themesBox.open) void refreshTriage(state);
        paintNeeds(state, true);
        void refreshActive(state);
        if (state.home?.slots.opsBox.open) void refreshOps(state);
      }
      refreshSoon(state);
      return;
    }
    case "approve":
      view.querySelector<HTMLButtonElement>(`.${REVIEW_FORM_CLASS} button[data-action="${APPROVE_ACTION}"]`)?.click();
      return;
    case "compose":
    case "comment":
      // With no line focused in a PR, c goes to the review text.
      view.querySelector<HTMLTextAreaElement>("form textarea")?.focus();
      return;
    case "help":
      state.help = !state.help;
      renderChrome(state);
      return;
    case "capture":
      state.capture?.focus();
      return;
    default:
      if (cmd.startsWith("section:")) jumpTo(state, cmd.slice("section:".length));
  }
}

/** Open a section and scroll to it, as the section keys do; remembered like any opening. */
function jumpTo(state: State, id: string): void {
  if (!isSection(id) || !state.home) return;
  setSectionOpen(state.home, id, true, true, homeHooks(state));
  loadSections(state);
  state.home.sections[id].details.scrollIntoView?.({ block: "start" });
  // The first row of it, so j/k go on from there.
  const first = state.home.sections[id].details.querySelector<HTMLElement>(`.${ROW_CLASS}`);
  if (first) {
    state.selected = rowId(first);
    markSelected(state, false);
  }
}

/** The list a row belongs to, for where "next" goes after acting on what it opens. */
function openedFrom(el: Element): State["openedFrom"] {
  if (el.closest(".themes-fold")) return "themes";
  return el.closest(`[${ROW_SECTION_ATTR}="priority"]`) ? "priority" : "needs";
}

/** Remember which list a link to an item or PR is in, so acting on it moves on in that list. */
function installOpenedFrom(state: State): void {
  byId("view").addEventListener("click", (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest("a[href^='#item/'], a[href^='#pr/']") : null;
    if (a) state.openedFrom = openedFrom(a);
  });
}

function installKeys(state: State): void {
  document.addEventListener("keydown", (ev) => {
    const where = route().route;
    const cmd = keyCommand(
      { key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, editing: ev.isComposing || isEditing(document.activeElement) },
      where,
    );
    if (!cmd) return;
    // Enter on a focused link or button does its own thing.
    if (ev.key === "Enter" && document.activeElement instanceof HTMLElement && document.activeElement.matches("a, button, summary")) return;
    ev.preventDefault();
    if (cmd === "blur") {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    run(state, cmd, where);
  });
}

/**
 * The auto-advance setting's header button, and the marks writingElsewhere
 * reads: a field he typed into holds his text, not a prefilled one.
 */
function installAdvance(state: State): void {
  const button = byId("advance");
  const show = () => {
    button.textContent = `Auto-next: ${state.advance ? "on" : "off"}`;
    button.setAttribute("aria-pressed", String(state.advance));
  };
  show();
  button.hidden = false;
  button.onclick = () => {
    state.advance = !state.advance;
    saveAdvance(state.advance);
    show();
  };
  byId("view").addEventListener("input", (ev) => {
    if (ev.target instanceof HTMLElement) ev.target.setAttribute(EDITED_ATTR, "");
  });
}

type Theme = "auto" | "light" | "dark";
const THEMES: readonly Theme[] = ["auto", "light", "dark"];

function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  byId("theme").textContent = `Theme: ${theme}`;
}

/** A per-browser convenience; storage may be blocked. */
function installTheme(): void {
  let theme: Theme = "auto";
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved && (THEMES as readonly string[]).includes(saved)) theme = saved as Theme;
  } catch {
    // Default theme.
  }
  applyTheme(theme);
  byId("theme").onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "auto";
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not remembered.
    }
  };
}

/** Which token problem to explain on the sign-in page. */
type SignInReason = "none" | "rejected";

/**
 * GitHub rejected the token, at load or any time later (revoked or
 * expired mid-session): stop, forget the token and everything read with
 * it, and ask for a new one. Once only, whichever read saw the 401.
 */
function rejected(state: State): Promise<void> {
  if (!state.rejecting) {
    state.closed = true;
    if (state.chat?.attached()) keptChat = state.chat;
    else state.chat?.dispose();
    viewClosed = true;
    state.poller.close();
    clearInterval(state.metaTicker);
    clearInterval(state.ticker);
    state.pane?.dispose();
    state.rejecting = Promise.allSettled([forgetCache(state.session, () => deleteCacheDatabase()), state.source.signOut()]).then(() => showSignIn("rejected"));
  }
  return state.rejecting;
}

async function start(source: TokenSource): Promise<void> {
  const session = await openCache(await source.get(), source.persistence === "local", () => IdbStore.open(), () => deleteCacheDatabase());
  const state: State = {
    sources: {},
    runsStarted: 0,
    runsRunning: false,
    poller: newPoller(() => state),
    tickedAt: Date.now(),
    gh: new GitHub(() => source.get(), undefined, session.cache),
    source,
    session,
    closed: false,
    prCachedAt: new Map(),
    items: [],
    linked: [],
    loaded: false,
    prs: [],
    others: [],
    waiting: [],
    waitingReads: new Map(),
    verdicts: new Map(),
    lastForgePoll: 0,
    forceForge: false,
    forgeKnown: false,
    filter: loadFilter(),
    verdictsRunning: false,
    waitingRunning: false,
    entries: [],
    sent: new Set(),
    answered: new Set(),
    rerunning: new Set(),
    rerunsSent: new Set(),
    answeredSeq: 0,
    reviewed: new Map(),
    pending: new Map(),
    context: new Map(),
    details: new Map(),
    reloadedFor: new Map(),
    help: false,
    hash: window.location.hash,
    advance: loadAdvance(),
    selected: undefined,
    openedFrom: "needs",
    prefs: loadSectionPrefs(),
    needs: [],
    needsPriority: loadNeedsPriority(),
    answeredHere: new Set(),
    triageFilter: "all",
    harness: new Map(),
    opsStarted: 0,
    opsRunning: false,
    activeStarted: 0,
    activeRunning: false,
    jobs: new Map(),
    triageOpen: new Set(),
    decisionsAnswered: new Set(),
  };
  state.gh.onUnauthorized = () => void rejected(state);
  byId("meta").textContent = "Checking the token…";
  // This token was used here before: show what it saw last time, as the
  // login it had then, while GitHub confirms it.
  if (session.knownLogin) state.login = session.knownLogin;
  const cached = session.knownLogin ? showCached(state) : Promise.resolve();
  try {
    state.login = await viewer(state.gh);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) {
      await cached;
      await rejected(state);
      return;
    }
    // Anything else (offline, rate limited, the page suspended while it
    // waited) the poll reports too; it also asks again (confirmLogin).
    state.loginError = message(e);
  }
  // Persist from now on, as this login's; a store another login filled is wiped.
  if (state.login && !state.loginError && session.store) await session.cache.attach(session.store, state.login, session.tokenHash);
  const lacking = missingScopes(state.gh.scopes, CLASSIC_SCOPES);
  if (lacking.length) {
    state.tokenWarning = `This token lacks the ${lacking.map((n) => n.any.join(" or ")).join(", ")} scope${lacking.length > 1 ? "s" : ""}; some reads or answers will fail.`;
  }
  byId("signout").hidden = false;
  const copy = document.getElementById("copy-state");
  if (copy) {
    copy.hidden = false;
    copy.onclick = () => {
      if (state.closed) return;
      if (!navigator.clipboard) { setNotice("Clipboard unavailable; open state.json to select and copy the text."); return; }
      navigator.clipboard.writeText(JSON.stringify(snapshot(state), null, 2)).then(() => setNotice("State copied."), (e: unknown) => setNotice(`Couldn't copy state: ${message(e)}`));
    };
  }
  const exportLink = document.getElementById("state-link");
  if (exportLink) exportLink.hidden = false;
  if (state.login === OPERATOR) showCapture(state);
  byId("signout").onclick = () => {
    state.closed = true;
    state.chat?.dispose();
    state.poller.close();
    clearInterval(state.metaTicker);
    forgetDraft(captureStore());
    void Promise.allSettled([forgetCache(session, () => deleteCacheDatabase()), source.signOut()]).then(() => window.location.reload());
  };
  window.addEventListener("hashchange", () => {
    const from = state.hash;
    state.hash = window.location.hash;
    if (state.doneAt === undefined || !sameHash(state.hash, state.doneAt)) hideDone(state);
    else delete state.doneAt;
    // An entry opened from a list of the page: an action on it moves on in
    // that list's order. From anywhere else (a link), no list of his:
    // acted() then follows "Needs you". Moving between entries keeps the list.
    const to = route().route;
    const came = parseRoute(from).route;
    if (to === "item" || to === "pr") {
      if (came === "home") {
        state.origin =
          state.openedFrom === "themes" ? themesOrigin(state, "#") : state.openedFrom === "priority" ? queueOrigin(state, "#") : needsOrigin(state, "#");
      } else if (came !== "item" && came !== "pr") delete state.origin;
    }
    renderRoute(state);
    // Back on the page from an entry, he is on the row he left; picking a filter leaves him where he is.
    if (to === "home" && came !== "home") markSelected(state, true);
    else if (to !== "home") window.scrollTo(0, 0);
  });
  installKeys(state);
  installOpenedFrom(state);
  installAdvance(state);
  // Mobile Safari suspends a page in the background, often without a
  // visibilitychange on return; any of these may be the first sign of it.
  document.addEventListener("visibilitychange", () => state.poller.visibilityChanged(frozenSince(state)));
  window.addEventListener("pagehide", () => state.poller.suspend());
  for (const ev of ["pageshow", "focus"]) window.addEventListener(ev, () => state.poller.wake(frozenSince(state)));
  state.metaTicker = setInterval(() => {
    state.tickedAt = Date.now();
    if (state.loaded && !document.hidden) {
      renderChrome(state);
      if (actionRunsDue(state)) void refreshActionRuns(state);
      // Waiting ages move on without a redraw of the rows.
      tickAges(document.body, Date.now());
    }
  }, META_TICK_MS);
  await cached;
  if (state.loaded) renderChrome(state);
  else renderRoute(state);
  state.poller.now();
}

/**
 * Mount the capture bar. Only for OPERATOR: the bot triages only his
 * issues, so anyone else's would sit there with the label.
 */
function captureStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    // Blocked: the draft won't survive a reload.
    return undefined;
  }
}

function showCapture(state: State): void {
  const storage = captureStore();
  const reposKey = "review.capture.repos";
  let recentRepos: string[] = [];
  try {
    const saved: unknown = JSON.parse(storage?.getItem(reposKey) ?? "[]");
    if (Array.isArray(saved)) recentRepos = saved.filter((r): r is string => typeof r === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r)).slice(0, 10);
  } catch { /* Suggestions are optional. */ }
  state.capture = captureBar({
    file: (draft) => fileCapture(state.gh, draft),
    linkTitle: (ref) => loadLinkTitle(state.gh, ref),
    labels: () => loadCaptureLabels(state.gh),
    epics: () => loadCaptureEpics(state.gh),
    recentRepos,
    filed: (draft) => {
      const repo = draft.repo?.trim();
      if (repo) {
        recentRepos = [repo, ...recentRepos.filter((r) => r !== repo)].slice(0, 10);
        try { storage?.setItem(reposKey, JSON.stringify(recentRepos)); } catch { /* Suggestions are optional. */ }
        const list = state.capture?.el.querySelector("datalist");
        list?.replaceChildren(...recentRepos.map((r) => h("option", { value: r })));
      }
      if (!state.closed) state.poller.now();
    },
    storage,
  });
  const slot = byId("capture");
  slot.replaceChildren(state.capture.el);
  slot.hidden = false;
  state.capture.mounted();
  state.chat?.dispose();
  if (keptChat?.attached()) {
    keptChat.useGitHub(state.gh);
    state.chat = keptChat;
  } else {
    keptChat?.dispose();
    const chat = chatPanel(state.gh);
    state.chat = chat;
    if (chat) {
      const chatSlot = byId("chat");
      chat.mount(chatSlot);
      chatSlot.hidden = false;
    }
  }
  keptChat = undefined;
}

function scopeList(): HTMLElement {
  const list = h("ul", { class: "scopes" });
  for (const need of CLASSIC_SCOPES) {
    const names = need.any.map((s) => h("code", {}, s));
    const label = names.flatMap((n, i) => (i ? [" or ", n] : [n]));
    list.append(h("li", {}, ...label, ` — ${need.why}`));
  }
  return list;
}

function signInView(reason: SignInReason): HTMLElement {
  const input = h("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "GitHub token",
    placeholder: "github_pat_… or ghp_…",
  });
  const remember = h("input", { type: "checkbox", id: "remember" });
  const status = h("p", { class: "status", role: "status" });
  const form = h(
    "form",
    { class: "signin" },
    h("h2", {}, "Sign in with a token"),
    reason === "rejected"
      ? h("p", { class: "warn" }, "GitHub rejected the saved token: it has expired or was revoked. Paste a new one.")
      : null,
    h(
      "p",
      {},
      "Paste a GitHub personal access token. It stays in this browser and is sent only to api.github.com; this page has no server. Everything you see is read with it, so the page shows nothing your token can't read.",
    ),
    input,
    h("label", { class: "check", for: "remember" }, remember, " Remember on this device: the token in localStorage, and what the app read in IndexedDB so it starts at once. Otherwise both are forgotten when you close the tab."),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Use token")),
    status,
    h(
      "details",
      { class: "help" },
      h("summary", {}, "Which token?"),
      h(
        "p",
        {},
        "A classic token with a short expiry reads everything the queue shows, upstream repositories included. It needs:",
      ),
      scopeList(),
      h(
        "p",
        {},
        "A fine-grained token acts on one resource owner only: with owner jmarrero-forge and Pull requests: read and write, Issues: read and write, and Contents and Commit statuses: read, it can review forge PRs and answer the bot's questions in jmarrero-forge/tracker. Make it mine also needs Contents: read and write, to rewrite a PR's commits. The capture bar files issues with Issues: write, and adds them to the board with the organization's Projects: read and write (on a classic token, the project scope).",
      ),
      h("p", {}, "Anyone who can change this site's code could read a pasted token, so prefer one that expires soon."),
    ),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    try {
      const persistence: Persistence = remember.checked ? "local" : "session";
      const source = useToken(input.value, persistence);
      input.value = "";
      void start(source);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  return h("main", {}, form);
}

function showSignIn(reason: SignInReason): void {
  byId("meta").textContent = "";
  byId("signout").hidden = true;
  for (const id of ["state-link", "copy-state"]) {
    const control = document.getElementById(id);
    if (control) control.hidden = true;
  }
  byId("capture").hidden = true;
  byId("capture").replaceChildren();
  setNotice(undefined);
  byId("view").replaceChildren(signInView(reason));
}

/** Keep --header-h at the sticky header's height, for the sticky file names below it. */
function trackHeaderHeight(): void {
  const header = document.querySelector<HTMLElement>("header.top");
  if (!header) return;
  const set = () => document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
  new ResizeObserver(set).observe(header);
  set();
}

/** The controls menu a narrow screen folds the header's buttons into. */
function installMenu(): void {
  const toggle = byId("menu-toggle");
  const menu = byId("menu");
  const setOpen = (open: boolean) => {
    menu.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => setOpen(!menu.classList.contains("open")));
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof Node && !menu.contains(ev.target) && !toggle.contains(ev.target)) setOpen(false);
  });
  // Escape closes an open menu, and only that (not also going back, as the keys do).
  for (const el of [menu, toggle]) {
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !menu.classList.contains("open")) return;
      ev.stopPropagation();
      setOpen(false);
      toggle.focus();
    });
  }
}

async function main(): Promise<void> {
  installTheme();
  installMenu();
  trackHeaderHeight();
  // A CSP meta tag can't forbid framing, so refuse to run in a frame:
  // otherwise another site could overlay the approve and send buttons.
  if (window.top !== window.self) {
    setNotice("This page refuses to run inside a frame. Open it directly.");
    return;
  }
  const saved = savedToken();
  if (saved) await start(saved);
  else showSignIn("none");
}

main().catch((e: unknown) => {
  setNotice(`The app failed to start: ${e instanceof Error ? e.message : String(e)}`);
});
