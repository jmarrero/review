// Entry point: sign-in, routing between the views of the one page of
// sections, board items and forge PRs, keyboard commands, and polling
// while the tab is visible, of only what the view on screen shows.

import { formatAnswer, parseQuestion } from "../answer.ts";
import { h } from "../dom.ts";
import { todayView } from "./today.ts";
import { focusView } from "./focus.ts";
import { readSource, type Sources } from "./freshness.ts";
import { createRenderer } from "../markdown.ts";
import { GitHub, GitHubError } from "./api.ts";
import { missingScopes, type Persistence, savedToken, type TokenSource, useToken } from "./auth.ts";
import { itemAction, reviewAskFor, reviewComment, type RunRef } from "./asks.ts";
import type { IssueRef, Item } from "./board.ts";
import { findRouteItem, loadRouteItem } from "./itemroute.ts";
import {
  answerHold,
  readAnswerTarget,
  approveAt,
  asOperator,
  type Context,
  loadContext,
  loadRuns,
  MaybeSentError,
  readMember,
  promoteMember,
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
  stillReviewed,
  writingElsewhere,
} from "./advance.ts";
import { type CacheSession, forgetCache, openCache } from "./cache.ts";
import { fileCapture, loadCaptureEpics, loadCaptureLabels, loadLinkTitle } from "./capture.ts";
import { type CaptureBar, captureBar, forgetDraft } from "./captureview.ts";
import { answerShownEntry, DECISIONS_CONFIG, DOCUMENT_KEPT, DocumentChanged, type DocumentEntry, documentPath, type Mark, parseDocument, sendDocumentEdit } from "./decisiondocument.ts";
import { epicChips, epicChoice, epicSelection, saveEpicChoice, type EpicFilter } from "./epicfilter.ts";
import { type Card, askHref, cardOutstanding, decisionKey, firstPublished, githubTarget, inboxCards, inboxCounts, mayAct, members, type Published, publishedNote, refusal } from "./inbox.ts";
import { mergeOrEnqueue } from "./merge.ts";
import { chatPanel, type ChatPanel } from "./chat.ts";
import { CHAT_CONFIG } from "./chatconfig.ts";
import { type ChatAnswer, chatItem, type ChatItem, startChatButton } from "./chatitem.ts";
import { CARD_CLASS, CARD_DONE_CLASS, cardEl, fillActNow, fillInbox, type InboxHooks, publishedContext } from "./inboxview.ts";
import { actNowGap, actNowRows, labelledIssues, mergeRefusal } from "./actnow.ts";
import { loadNeedsHuman, NEEDS_HUMAN_LABEL, NEEDS_HUMAN_QUERY, type NeedsHumanRead } from "./needshuman.ts";
import {
  CLASSIC_SCOPES,
  DONE_NOTICE_MS,
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
import { type Command, HELP, keyCommand, parseRoute, type Route, type RouteInfo } from "./keys.ts";
import { deleteCacheDatabase, IdbStore } from "./idbstore.ts";
import type { Active } from "./inbox.ts";
import { fillStatus, fillPeople, fillState, type Home, HOME_CLASS, type HomeHooks, homeSkeleton, stepRow, walkRows } from "./homeview.ts";
import { ACTION_CONFIG, loadOffer } from "./actions.ts";
import { proposalCard } from "./actionsview.ts";
import { type DraftIssue, loadDraftIssue, REVIEW_DRAFT_CONFIG, refText } from "./reviewdrafts.ts";
import { draftCard, draftReviewForm } from "./reviewdraftsview.ts";
import { type ApproveResult, approveSelected } from "./maintain.ts";
import { loadProjectStatus } from "./backend.ts";
import { type Need, needStops } from "./needs.ts";
import { type Ask, loadPassPublications, readHoldAsk } from "./holds.ts";
import { repositoriesView, type ReportBlock } from "./repositories.ts";
import type { BoardPublication } from "./repositoryboard.ts";
import { actionButton, activePassView, type AgentActions, type PassView, retainPassView } from "./passview.ts";
import { cancelLiveRun, LIVE_POLL_MS, liveAgentsView, loadLiveRuns, type LiveRuns } from "./liveruns.ts";
import { runPassControl, type PassControl } from "./runpass.ts";
import { itemDispatchControl, type ItemDispatchState } from "./itemdispatch.ts";
import { cancelRun, redispatch, retryRun } from "./agentruns.ts";
import { type PassesRead, readPasses, schedulerPassView } from "./passesview.ts";
import { activityView } from "./activityview.ts";
import { stale } from "./passes.ts";
import { ago } from "../time.ts";
import { type ServiceDecision, type ServiceState, serviceLiveRuns, serviceProblem, watchServiceState } from "./service.ts";
import { serviceDecisionView } from "./serviceview.ts";
import { serviceBoardView } from "./serviceboard.ts";
import { type Delay, Poller, pollDelay, pollNote } from "./poller.ts";
import { saveMine } from "./mine.ts";
import { MINE_CLASS } from "./mineview.ts";
import { loadPeople, markPeopleDone, type People } from "./people.ts";
import { peopleMeta } from "./peopleview.ts";
import {
  loadFileLines,
  loadPrDetail,
  loadRangeFiles,
  type OtherPr,
  type PrDetail,
  submitReview,
  type VerdictEntry,
  type WaitingPr,
  type WaitingRead,
} from "./prs.ts";
import { APPROVE_ACTION, canReview, type PrPane, prView, REVIEW_FORM_CLASS, type ReviewAskInfo } from "./prview.ts";
import { buildEntries, type Entry, itemHref, onBot } from "./queue.ts";
import { DEFAULT_VIEW, fillNav, SECTION_VIEW, showView, VIEW_ATTR, VIEW_TITLE, type ViewId, viewHash, VIEWS, visibleView } from "./shell.ts";
import { checkedText, SourceLayer } from "./sourcelayer.ts";
import { loadAdvance, saveAdvance } from "./store.ts";
import type { Decision } from "./triage.ts";
import { agoLabel, answerForm, answerState, type BoardHref, clock, type ContextHooks, CONTEXT_CLASS, contextView, itemView, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, type RowLabel, STATE_LABEL, tickAges } from "./view.ts";
import { ON_BOT_LABEL, REASON_LABEL } from "./waiting.ts";

const render = createRenderer(window);
// Only the explicit private hosted build inserts this marker. Pages stays static.
const serviceMode = document.querySelector('meta[name="service-decisions"]')?.getAttribute("content") === "enabled";
const serviceRunsMode = document.querySelector('meta[name="service-runs"]')?.getAttribute("content") === "enabled";
const serviceBoardMode = document.querySelector('meta[name="service-board"]')?.getAttribute("content") === "enabled";
const serviceStream = serviceMode || serviceRunsMode || serviceBoardMode;

interface State {
  service?: ServiceDecision;
  serviceState?: ServiceState | undefined;
  /** The service board's repository filter; undefined shows every repository. */
  serviceRepository?: string | undefined;
  serviceStreamError?: string | undefined;
  serviceError?: string | undefined;
  serviceOnly?: boolean;
  stopService?: () => void;
  cardWrites?: Map<string, HTMLElement>;
  completedAsks?: Map<string, string>;
  /** The inbox's epic filter, for the viewer who chose it. */
  inboxChoice?: { login: string | undefined; value: EpicFilter };
  routed?: { id: string; item?: Item; error?: string; loading?: boolean };
  people?: People;
  peopleRunning?: boolean;
  peopleRevision?: number;
  peopleWrites?: number;
  /** The direct needs-human read, made only while the pass's list cannot vouch for Act now. */
  needsHuman?: NeedsHumanRead;
  needsHumanRunning?: boolean;
  /** What the views show and when each is read (see newLayer). */
  layer: SourceLayer<ViewId>;
  /** The view of the page last shown, which a bare # (e.g. "Back") returns to. */
  view: ViewId;
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
  /** Published status and the board, heartbeat and holds used as inbox context. */
  active?: Active;
  activeRunning: boolean;
  /** The last pass view read, kept while a refresh of the publication fails. */
  passView?: PassView | undefined;
  /** The agent workflows' unfinished runs, read from the Actions API (liveruns.ts). */
  liveRuns?: LiveRuns;
  liveRunning?: boolean;
  passControl?: PassControl;
  /** Each item's dispatch form, by refKey, so a re-render keeps its plan and polling. */
  itemDispatch?: Map<string, ItemDispatchState>;
  passes: PassesRead;
  repositories?: ReportBlock[];
  repositoryWork?: Pick<BoardPublication, "work" | "at">;
  /** The page's sections, while it is shown. */
  home?: Home;
  /** The rows of "Needs you" as last drawn, and a signature of them. */
  needs: Need[];
  /** The inbox's cards and their sources beyond the needs. */
  inbox?: Inbox;
  /** Viewer choice survives leaving the home page, even when storage is blocked. */
  /** What the pass's needs-you list said when last read. */
  published: Published;
  /** Why GitHub hasn't confirmed `login` (it is then the cache's, or unknown); retried at each poll. */
  loginError?: string;
  loginChecking?: boolean;
  /** Keys of questions answered from the page: kept in the list, dimmed, until a reload. */
  answeredHere: Set<string>;
  /** The open PR's pane, which handles its own keys. */
  pane?: PrPane;
  /** The capture bar, shown to OPERATOR only. */
  capture?: CaptureBar;
  /** The chat drawer, OPERATOR's only, opened from Needs you. */
  chat?: ChatPanel | undefined;
  help: boolean;
  /** The location hash last routed to. */
  hash: string;
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
  /** The open decisions, in order, and when a cached copy was fetched. */
  decisions?: Decision[];
  decisionsCachedAt?: number;
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

function routeItemId(state: State): string | undefined {
  const r = route();
  return r.route === "item" ? routedItem(state, r.id)?.nodeId : undefined;
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
 * The header's meta line, how fresh the data is, and the controls menu's:
 * who is signed in, the people and bot counts, and the rate budget.
 */
function renderMeta(state: State): void {
  if (state.serviceOnly && !serviceMode && !serviceRunsMode) {
    byId("meta").textContent = `Service generation ${state.serviceState?.generation ?? "unknown"} · ${state.serviceStreamError ?? (state.serviceState ? "received" : "unavailable")} · read-only`;
    return;
  }
  if (state.serviceOnly && !serviceMode) {
    const live = serviceLiveRuns(state.serviceState, Date.now(), state.serviceStreamError);
    byId("meta").textContent = `Service runs generation ${state.serviceState?.generation ?? "unknown"} · ${live.errors.join("; ") || "complete"} · read-only`;
    return;
  }
  if (serviceMode) {
    byId("meta").textContent = `Service generation ${state.service?.generation ?? "unknown"} · ${state.serviceError ?? (state.service ? serviceProblem(state.service, Date.now()) ?? (state.service.complete ? "complete" : "partial") : "unavailable")} · read-only`;
    return;
  }
  const parts: Node[] = [];
  const part = (cls: string, ...children: (string | Node)[]) => parts.push(h("span", { class: `mp ${cls}` }, ...children));
  // From what waits now, not state.needs (the rows drawn), which stays behind while a redraw is deferred under a half-written answer.
  const botCount = inboxCounts(state.published, state.completedAsks).outstanding;
  const people = peopleMeta(state.people, !!state.home?.el.isConnected && !!state.home.el.querySelector<HTMLDetailsElement>("#sec-people")?.open);
  byId("menu-meta").replaceChildren(...[
    state.login ? `signed in as ${state.login}` : undefined,
    h("span", { title: people.title }, people.text, ` · bot ${botCount}`),
    state.gh.rate ? `API ${state.gh.rate.remaining}/${state.gh.rate.limit}` : undefined,
  ].flatMap((p) => (p ? [h("span", { class: "mp" }, p)] : [])));
  const since = cachedSince(state);
  if (since !== undefined) part("mp-age", h("span", { class: "cached", title: "Shown from this browser's cache; checking GitHub for changes" }, "cached · ", agoLabel(new Date(since).toISOString(), Date.now())));
  else if (state.home?.el.isConnected) part("mp-age", viewChecked(state.layer, state.view, Date.now()));
  else if (state.lastPoll) part("mp-age", "checked ", agoLabel(state.lastPoll.toISOString(), Date.now()));
  // Why it isn't being refreshed as usual, if it isn't. Only the queue's
  // cached copy (also shown behind an item) is re-read by the poll itself;
  // PRs have loaders of their own.
  const r = route().route;
  const note = pollNote(state.poller.status(), Date.now(), POLL_SLOW_MS, since !== undefined && r !== "pr");
  if (note) part("mp-note", h("span", { class: "cached", title: "Not refreshing from GitHub as usual" }, note));
  byId("meta").replaceChildren(...parts);
}

/** The view's "checked N s ago", with each of its sources' in the tooltip. */
function viewChecked(layer: SourceLayer<ViewId>, view: ViewId, now: number): HTMLElement {
  const f = layer.freshness(view);
  const title = f.sources.map((s) => `${s.name} (${s.path}): ${s.checked === undefined ? "not read yet" : `checked ${new Date(s.checked).toLocaleTimeString()}`}`).join("\n");
  return h("span", { title: `What ${VIEW_TITLE[view]} shows:\n${title}` }, checkedText(f.at, now));
}

/** Meta line and notices only: never touches the view, or a half-typed answer. */
function renderChrome(state: State): void {
  if (state.closed) return;
  renderMeta(state);
  const json = document.getElementById("state-json");
  const model = snapshot(state);
  if (json) json.textContent = JSON.stringify(model, null, 2);
  fillNav(byId("views"), state.view);
  if (state.home?.el.isConnected) {
    fillState(state.home, model);
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

/** The page's section hooks: what opening one starts. */
function homeHooks(state: State): HomeHooks {
  return {
    toggled: (_id, open) => {
      if (open) tickSources(state);
    },
    peopleToggled: (open) => {
      renderChrome(state);
      if (open && !state.serviceOnly) void refreshPeople(state);
    },
  };
}

/** The page, built once and kept while it is shown: its sections are filled in place. */
function mountHome(state: State): Home {
  if (state.home) {
    if (!state.home.el.isConnected) showMain(state.home.el);
    return state.home;
  }
  state.home = homeSkeleton(homeHooks(state));
  mountInbox(state, state.home);
  showMain(state.home.el);
  return state.home;
}

interface Inbox {
  filters: HTMLElement;
  list: HTMLElement;
  /** What holds every new run, if anything (passLine). */
  pass: HTMLElement;
  /** Why something it reads can't be shown, over the cards. */
  status: HTMLElement;
  /** Those reasons, by what was read. */
  notes: Map<string, string>;
  empty: HTMLElement;
  document?: { body: string; marks: Map<string, Mark> };
  drafts?: DraftIssue[];
  /** Document writes, one after another, each on the body the last left. */
  writes: Promise<void>;
  /** Proposal executions: one at a time, and no reload of the proposals (which would redraw its card) meanwhile. */
  busy: boolean;
  /** Opens a chat about no card; shown while the chat drawer is. */
  startChat?: HTMLElement | null;
}

/**
 * The inbox's cards, in place of the Decisions rows, the decisions
 * document and the opt-in panels. It opens on the first card; Draft
 * review follows the list.
 */
function mountInbox(state: State, home: Home): void {
  const list = h("div", { class: "inbox-cards" });
  const status = h("p", { class: "note", role: "status" });
  const empty = h("p", { class: "empty", hidden: "" }, "All caught up: nothing needs you right now.");
  const tail = h("div", { class: "inbox-tail" });
  const inbox: Inbox = { list, filters: h("div"), pass: h("div"), status, notes: new Map(), empty, writes: Promise.resolve(), busy: false, startChat: startChatButton() };
  state.inbox = inbox;
  if (inbox.startChat) {
    inbox.startChat.hidden = !state.chat;
    tail.append(inbox.startChat);
  }
  if (REVIEW_DRAFT_CONFIG) tail.append(draftReviewForm(state.gh, REVIEW_DRAFT_CONFIG, () => refreshSoon(state)));
  home.sections.needs.body.prepend(inbox.filters, inbox.pass, status, list, empty, tail);
}

/** An ask's PR, as the PR pane and the review writes name it. */
const askPr = (a: Ask): IssueRef => {
  const [owner = "", repo = ""] = a.action.repository.split("/");
  return { owner, repo, number: a.action.number };
};

/** The receipt of the last answer attempted on an ask's target, shown beside a failed read so its outcome and comment URL stay visible. */
const answeredKey = (a: Ask): string => JSON.stringify(["answered", `${a.action.repository}#${a.action.number}`.toLowerCase()]);

/** A captured card or chat cannot authorize its representative after grouping or refusal. */
function singleAsk(state: State, a: Ask): void {
  const current = [...(state.published.holds ?? []), ...state.published.asks].find((x) => x.key === a.key);
  if (state.published.unavailable || !current || current.group || JSON.stringify(current.action) !== JSON.stringify(a.action) || refusal(current)) throw new Error("Ask left, changed, grouped or became unavailable; inspect it again.");
}

/**
 * Read an Answer card's target and ask now; `post` answers only that, as
 * the operator, releasing only an eligible needs-human hold. Its card and a
 * chat about it share the receipts, kept by `key`, so neither offers an
 * answer the other attempted.
 */
async function readAsk(state: State, a: Ask) {
  const target = `${a.action.repository}#${a.action.number}`;
  const receipts = state.cardWrites ??= new Map();
  const { owner, repo, number } = askPr(a);
  const shown = await readAnswerTarget(state.gh, target);
  const ask = await readHoldAsk(state.gh, owner, repo, number);
  const key = JSON.stringify([target.toLowerCase(), shown.title, shown.body, ask]);
  const check = async () => {
    if (await readHoldAsk(state.gh, owner, repo, number) !== ask) throw new Error("The ask changed; not releasing it. Reload and read it again.");
    singleAsk(state, a);
  };
  // Only needs-human is released, and only where the pass listed it so; other holds are the pass's.
  const release = a.kind === "needs-human" || a.kind === "review-needs-human";
  /**
   * Answer once, from the card or a chat: refused where the other sent or
   * may have (`receipt` holds [data-sent] then), kept as both's receipt,
   * and saying at once what it released; a comment alone releases nothing.
   */
  const send = async (text: string, receipt: HTMLElement): Promise<string> => {
    const attempted = receipts.get(key);
    if (attempted && attempted !== receipt && attempted.querySelector("[data-sent]")) throw new MaybeSentError(`Already attempted: ${attempted.querySelector("[role=status]")?.textContent ?? "check GitHub"}`);
    receipts.set(key, receipt);
    receipts.set(answeredKey(a), receipt);
    const url = await asOperator(state.gh, async () => (await answerHold(state.gh, target, text, shown, release, check)).url);
    receipt.closest(`.${CARD_CLASS}`)?.classList.add(CARD_DONE_CLASS);
    receipt.append(h("p", { class: "note", "data-sent": "" }, release
      ? `Released: needs-human on ${target}, the ${a.kind} hold. Other holds stay. Waiting on the agent.`
      : `Commented only: the ${a.kind} hold on ${target} stays until the pass sees it change.`));
    if (release) (state.completedAsks ??= new Map()).set(a.key, decisionKey(a));
    refreshSoon(state);
    paintInbox(state);
    return url;
  };
  return { target, shown, ask, key, release, receipts, send };
}

/** An Answer card's ask for a chat about it, answered through the card's path and receipts. */
async function chatAnswer(state: State, a: Ask): Promise<ChatAnswer> {
  const { target, shown, ask, release, send } = await readAsk(state, a);
  return {
    target, release,
    ask: [shown.title, shown.body, ask].filter(Boolean).join("\n\n"),
    send: async (text) => {
      const status = h("p", { class: "status", role: "status" });
      try {
        const url = await send(formatAnswer({ text }), h("div", {}, status));
        status.append("Answered from chat: ", h("a", { href: url }, url));
        return url;
      } catch (e) {
        // Only a write that may have gone out is kept: the card then offers it no more.
        if (e instanceof MaybeSentError) {
          status.textContent = `Not sent, or uncertain: ${e.message}`;
          status.setAttribute("data-sent", "");
        }
        throw e;
      }
    },
  };
}

/** A card's chat context: its item, what it asks and its public links, and an Answer card's ask to answer. */
function cardChat(state: State, c: Card): ChatItem | undefined {
  const item = chatItem(c.url, c.title);
  return item && {
    ...item,
    ask: [c.title, c.where, c.note].filter(Boolean).join(" · "),
    links: [c.url!],
    ...(c.kind === "answer" && !c.answered && mayAct(state.login) && !refusal(c.ask) ? { answer: () => chatAnswer(state, c.ask) } : {}),
  };
}

export function inboxHooks(state: State, drafts = REVIEW_DRAFT_CONFIG): InboxHooks {
  return {
    changed: () => { paintInbox(state); if (state.home) renderChrome(state); refreshSoon(state); },
    publishedBody: async (a) => {
      if (a.source === "drafts" && drafts && a.action.repository.toLowerCase() === drafts.tracker.toLowerCase()) {
        return draftCard(state.gh, drafts, render, await loadDraftIssue(state.gh, drafts, a.action.number), (sent) => {
          if (sent) (state.completedAsks ??= new Map()).set(a.key, decisionKey(a));
          paintInbox(state);
          refreshSoon(state);
        });
      }
      const target = DECISIONS_CONFIG.document;
      const id = /\/decision-([1-9]\d*)$/.exec(a.key)?.[1];
      if (a.source !== "decisions" || !target || !id || a.action.repository.toLowerCase() !== target.repo.toLowerCase() || a.action.number !== target.number) throw new Error("Inspect this published request on GitHub; no matching local writer is configured.");
      const body = (await state.gh.get<{ body: string }>(documentPath(target))).data.body;
      const entry = parseDocument(body).find((e) => e.id === `D${id}` && !e.done);
      if (!entry) throw new Error("This decision left the document; reload the inbox.");
      state.inbox!.document = { body, marks: new Map() };
      const hooks = inboxHooks(state, drafts);
      return cardEl({ kind: "document", key: `document:${entry.id}`, title: entry.title, where: a.item, entry }, { ...hooks,
        answerEntry: async (shown, letter, reply) => {
          singleAsk(state, a);
          await hooks.answerEntry(shown, letter, reply);
          (state.completedAsks ??= new Map()).set(a.key, decisionKey(a));
          paintInbox(state);
          renderChrome(state);
        },
      });
    },
    writes: state.cardWrites ??= new Map(),
    now: Date.now(),
    render,
    mayAct: mayAct(state.login),
    // Drawn by the same gate as the cards' own answers; the drawer, OPERATOR's, takes the request.
    ...(CHAT_CONFIG && mayAct(state.login) ? { chatItem: (c: Card) => cardChat(state, c) } : {}),
    answerBody: async (a) => {
      let read: Awaited<ReturnType<typeof readAsk>>;
      try {
        read = await readAsk(state, a);
      } catch (e) {
        const last = state.cardWrites?.get(answeredKey(a));
        if (!last?.querySelector("[data-sent]")) throw e;
        return h("div", {}, h("p", { class: "warn" }, String(e)), last);
      }
      const { target, shown, ask, key, release, receipts } = read;
      const { owner, repo, number } = askPr(a);
      const previous = receipts.get(key);
      if (previous?.querySelector("[data-sent]")) return previous;
      const form = answerForm({ owner, repo, number }, parseQuestion(shown.body ?? ""), false, (answer) => read.send(formatAnswer(answer), body), `card-${target}-`, 2);
      form.querySelector(".target")!.textContent = release
        ? `Posts your answer, then removes only needs-human on ${target}. Other holds stay.`
        : `Only a comment on ${target}: this hold cannot be released by an answer.`;
      const body = h("div", {}, h("div", { class: "md" }, render([shown.body, ask].filter(Boolean).join("\n\n"), `${owner}/${repo}`)), form);
      return body;
    },
    answerEntry: (entry, letter, reply) => asOperator(state.gh, () => answerEntry(state, entry, letter, reply)),
    approve: (a, head) => asOperator(state.gh, async () => {
      singleAsk(state, a);
      const ref = askPr(a);
      const found = reviewAskFor(state.items, ref);
      const result = await approveAt(state.gh, ref, head, found && { ref: found.ref, head: found.target.head });
      if (result.status === "approved" && result.url) reviewed(state, ref, head, "approve", result.url, found);
      if (result.status === "approved" || result.status === "already-approved") rebuildEntries(state);
      if (result.status === "approved" || result.status === "already-approved") (state.completedAsks ??= new Map()).set(a.key, decisionKey(a));
      return result;
    }),
    member: (ref) => readMember(state.gh, ref),
    merge: async (a, head) => {
      const result = await mergeOrEnqueue(state.gh, askPr(a), head, () => {
        singleAsk(state, a);
        const current = actNowRows(state.published, Date.now(), state.completedAsks).find((r) => r.ask.key === a.key && !r.fallback)?.ask;
        if (!current || current.action.type !== "pull_request" || current.action.head !== head) throw new Error("Ask no longer actionable at this head; reload.");
        const no = mergeRefusal(current);
        if (no) throw new Error(no);
      });
      (state.completedAsks ??= new Map()).set(a.key, decisionKey(a));
      return result;
    },
    promote: (a, ref, head, ci) => promoteMember(state.gh, ref, head, () => {
      const current = state.published.asks.find((x) => x.key === a.key);
      if (state.published.unavailable || !current || current.kind !== "review-promote" || current.action.repository.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase() || !members(current).includes(ref.number)) throw new Error("Member left this request; reload and inspect it.");
      const no = refusal(current, "promote");
      if (no) throw new Error(no);
    }, ci),
    // A report stays on its card until r; the pass lists the PRs until its next digest.
    approveDigest: (items) => asOperator(state.gh, async () => {
      // A kept card approves only what the pass still lists, ungrouped, in its digest.
      const listed = new Set([...(state.published.holds ?? []), ...state.published.asks]
        .filter((a) => !a.group && a.kind === "digest-approve").map((a) => `${a.action.repository}#${a.action.number}@${a.action.head}`.toLowerCase()));
      const live = items.filter((it) => listed.has(`${refText(it.pr)}@${it.head}`.toLowerCase()));
      const left = items.filter((it) => !live.includes(it)).map((it): ApproveResult => ({ pr: it.pr, status: "skipped", note: `${refText(it.pr)} left the digest or was grouped; inspect it` }));
      const results = [...left, ...(live.length ? await approveSelected(state.gh, live) : [])];
      for (const result of results) {
        if (result.status !== "approved" && result.status !== "already-approved") continue;
        for (const ask of state.published.asks.filter((a) => !a.group && `${a.action.repository}#${a.action.number}`.toLowerCase() === refText(result.pr).toLowerCase() && live.some((it) => it.pr === result.pr && it.head === a.action.head))) {
          (state.completedAsks ??= new Map()).set(ask.key, decisionKey(ask));
        }
      }
      paintInbox(state);
      refreshSoon(state);
      return results;
    }),
    ...(drafts ? { draftBody: (c) => draftCard(state.gh, drafts, render, c.draft) } : {}),
    ...(ACTION_CONFIG ? {
      offerBody: async (a) => proposalCard(state.gh, ACTION_CONFIG!, await loadOffer(state.gh, ACTION_CONFIG!, a.action), () => state.inbox?.busy === true, (v) => {
        if (!state.inbox) return;
        state.inbox.busy = v;
        // The queue now shows what it closed or merged; the card, with its
        // results, stays until the pass's list drops the proposal.
        if (!v) {
          paintInbox(state);
          refreshSoon(state);
        }
      }),
    } : {}),
  };
}

/**
 * Answer document entry `shown` (as its card drew it), on the body the
 * inbox last read or wrote. A card is kept unredrawn under an unsent pick,
 * so the entry may have changed since it was drawn: the letter is ticked
 * only while the entry still reads as shown, or it could tick another
 * option than the one he picked. A change elsewhere keeps the answer to
 * check and send again.
 */
function answerEntry(state: State, shown: DocumentEntry, letter: string, reply: string): Promise<void> {
  const inbox = state.inbox;
  const target = DECISIONS_CONFIG.document;
  if (!inbox?.document || !target) return Promise.reject(new Error("The decisions document isn't read yet"));
  const run = inbox.writes.then(async () => {
    const doc = inbox.document!;
    try {
      doc.body = await sendDocumentEdit(state.gh, documentPath(target), doc.body, (body) => answerShownEntry(body, shown, letter, reply));
    } catch (e) {
      if (!(e instanceof DocumentChanged)) throw e;
      // The next send builds on the document as it is now.
      doc.body = e.body;
      throw new Error(DOCUMENT_KEPT);
    }
  });
  inbox.writes = run.catch(() => {});
  return run.finally(() => refreshSoon(state));
}

/** Redraw the inbox's cards that changed; with `force` (he reloaded), those holding unsent text too. */
function paintInbox(state: State, force = false): void {
  const inbox = state.inbox;
  const home = state.home;
  // A redraw while a proposal executes could replace the card showing its progress.
  if (!inbox || !home || state.closed || inbox.busy) return;
  // Explicit refresh permits a new confirmed attempt after a definite refusal;
  // pending, successful and uncertain writes remain session receipts.
  if (force) for (const [key, body] of state.cardWrites ?? []) {
    if (key.startsWith('["merge",') && body.querySelector('[data-keep=""]') && !body.querySelector('[data-sent]')) state.cardWrites!.delete(key);
  }
  const cards = inboxCards({ published: state.published });
  const saved = state.inboxChoice?.login === state.login ? state.inboxChoice?.value : undefined;
  const deepLink = /^#epic-[1-9]\d{0,9}$/.test(window.location.hash);
  // A link anyone can send selects its epic for this visit; only a chip click is remembered.
  const choice = deepLink ? epicChoice(state.login, window.location.hash) : saved ?? epicChoice(state.login, "");
  state.inboxChoice = { login: state.login, value: choice };
  // Activity from a list that can't be read now, or none published, hides nothing.
  const epics = state.published.unavailable ? undefined : state.published.list?.epics;
  const waits = (c: Card) => cardOutstanding(c, state.published.asks, state.completedAsks);
  const selection = epicSelection(cards, epics, epics ? choice : "all", waits);
  const filtered = !!selection?.hidden;
  fillInbox(inbox.list, serviceMode ? cards : selection.ordered, inboxHooks(state), force, epics && choice !== "all" ? new Set(selection.selected.map((c) => c.key)) : undefined);
  const actNow = actNowRows(state.published, Date.now(), state.completedAsks);
  const gap = actNowGap(state.published, Date.now());
  // A read from an earlier gap is not shown as this one's.
  if (gap === undefined) delete state.needsHuman;
  fillActNow(home.slots.actNow, actNow, inboxHooks(state), gap === undefined ? undefined
    : { gap, ...(state.needsHuman ? { read: state.needsHuman } : {}), issues: labelledIssues(state.needsHuman, actNow, state.published, state.completedAsks) });
  if (inbox.startChat) inbox.startChat.hidden = !state.chat;
  const { text, settled } = publishedNote(state.published, Date.now());
  const list = state.published.list;
  const { known, listed, unlisted, completed, outstanding } = inboxCounts(state.published, state.completedAsks);
  // The heading and chips count rows; decisions (the pass's unit) and rows
  // each get one sentence whose parts add up to its total.
  const waiting = selection.selected.filter(waits).length;
  const detailed = cards.filter((c) => !("ask" in c && c.ask.detailMissing)).length;
  inbox.pass.replaceChildren(h("p", { class: `note published${settled ? "" : " warn"}` }, serviceMode ? text.replace("checked on GitHub", "received from service") : text),
    h("p", { class: "note" }, `${known} decisions reported: ${listed} listed, ${unlisted} not listed. ${cards.length} rows (${detailed} with detail): ${waiting} waiting, ${selection.selected.length - waiting} done here, ${selection.hidden} hidden by the epic filter. Groups: ${list?.counts?.groups ?? "unknown"}, members: ${list?.counts?.members ?? "unknown"}.`));
  const contextOpen = inbox.filters.querySelector<HTMLDetailsElement>(".published-context")?.open;
  const context = publishedContext(list?.context);
  if (contextOpen) context.open = true;
  const focused = inbox.filters.ownerDocument.activeElement;
  const focusedChoice = focused && inbox.filters.contains(focused) ? focused.getAttribute("data-epic-choice") : null;
  inbox.filters.replaceChildren(epics ? epicChips(selection, choice, (next) => {
    state.inboxChoice = { login: state.login, value: next };
    saveEpicChoice(state.login, next);
    if (deepLink) window.history.replaceState(null, "", "#inbox");
    paintInbox(state);
  }) : "", context);
  // Polls and choices redraw the chips: keep keyboard focus on the same one.
  if (focusedChoice) {
    const chips = [...inbox.filters.querySelectorAll<HTMLButtonElement>("button[data-epic-choice]")];
    (chips.find((b) => b.getAttribute("data-epic-choice") === focusedChoice) ?? chips[0])?.focus({ preventScroll: true });
  }
  // Empty says nothing waits only when the pass's list is complete and current.
  inbox.empty.hidden = filtered ? selection.selected.length > 0 : known > 0 || !settled;
  inbox.empty.textContent = filtered ? "Nothing here matches this filter: Show everything to see the rest." : "All caught up: nothing needs you right now.";
  const count = home.sections.needs.count;
  count.textContent = String(waiting);
  count.title = `${waiting} outstanding published rows; ${outstanding} reported decisions outstanding${filtered ? `; ${selection.hidden} rows hidden by this filter` : ""}; ${completed} local sent receipts excluded; retained drafts excluded${settled ? "" : "; the pass's list is not complete and current, so more may wait"}`;
  count.classList.toggle("hot", waiting > 0);
  markSelected(state, false);
}

function renderHome(state: State): void {
  const r = route();
  // A view in the hash is shown; a bare # shows the last one.
  if (r.route === "home" && r.view) state.view = r.view;
  // Drawn once while the page stays: a redraw of it must not take half-typed answers away.
  const fresh = !state.home;
  const home = mountHome(state);
  showView(home.el, state.view);
  renderChrome(state);
  paintNeeds(state, fresh);
  paintPeople(state);
  paintActive(state);
  markSelected(state, false);
  tickSources(state);
}

function currentNeeds(state: State): Need[] {
  return state.published.asks.filter((a) => githubTarget(a) && state.completedAsks?.get(a.key) !== decisionKey(a)).map((a) => ({ key: a.key, action: "review", title: a.ask, where: a.item, href: askHref(a.action), inPlace: false }));
}

export function snapshot(state: State) {
  const sources = { ...state.active?.sources, ...state.sources };
  if (state.active?.fromCache) for (const name of Object.keys(state.active.sources ?? {})) {
    const source = sources[name];
    if (source?.state === "ok") sources[name] = { ...source, state: "cached" };
  }
  return { schema: "review-inbox-state/v1", generatedAt: new Date().toISOString(), status: state.active?.status ?? null, published: state.published, sources };
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
  state.needs = needs;
  paintInbox(state, force);
  renderChrome(state);
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

/** Re-read the people's asks while their fold is open; false if nothing was read (see SourceDef.read). */
async function refreshPeople(state: State): Promise<boolean> {
  if (!state.home?.el.querySelector<HTMLDetailsElement>("#sec-people")?.open) return false;
  if (state.peopleRunning || state.peopleWrites || state.closed) return false;
  state.peopleRunning = true;
  const revision = state.peopleRevision;
  try {
    const people = await readSource(state.sources, "people", (gh) => loadPeople(gh, Date.now(), state.login === OPERATOR), state.gh);
    if (state.closed) return false;
    if (!people || revision !== state.peopleRevision) { renderChrome(state); return false; }
    state.people = people;
    paintPeople(state);
    renderChrome(state);
    return true;
  } finally {
    state.peopleRunning = false;
  }
}

/** List open needs-human issues directly; a failed read is shown as failed, never as none. */
async function refreshNeedsHuman(state: State): Promise<boolean> {
  if (state.needsHumanRunning || state.closed) return false;
  state.needsHumanRunning = true;
  try {
    const read = await readSource(state.sources, NEEDS_HUMAN_LABEL, loadNeedsHuman, state.gh);
    if (state.closed) return false;
    state.needsHuman = read ?? { issues: [], error: state.sources[NEEDS_HUMAN_LABEL]?.error ?? "no reason given" };
    paintInbox(state);
    renderChrome(state);
    return read !== undefined;
  } finally {
    state.needsHumanRunning = false;
  }
}

/** Re-read the agent workflows' unfinished runs; false if nothing was read. */
async function refreshLive(state: State): Promise<boolean> {
  if (state.liveRunning || state.closed) return false;
  state.liveRunning = true;
  try {
    const live = await loadLiveRuns(state.gh);
    if (state.closed) return false;
    state.liveRuns = live;
    paintActive(state);
    return live.errors.length === 0;
  } finally {
    state.liveRunning = false;
  }
}

function paintActive(state: State): void {
  if (!state.home) return;
  const model = snapshot(state);
  const source = model.sources.holds;
  const unavailable = source && source.state !== "ok" ? source.error ?? source.state : undefined;
  const passUnavailable = state.active?.passPublicationError ?? unavailable;
  const pass = retainPassView(state.passView, state.active?.passPublicationError ? undefined : state.active?.holds?.passView, !!passUnavailable);
  state.passView = typeof pass === "object" ? pass : undefined;
  const facts = () => ({ data: state.passView, unavailable: state.closed ? "Signed out" : state.active?.passPublicationError ?? (state.active?.sources?.holds?.state !== "ok" ? "Publication unconfirmed" : undefined), login: state.login });
  // Bound to the view drawn: each write checks its run is one this view lists.
  const view = state.passView;
  const actions: AgentActions | undefined = view && state.login === OPERATOR ? {
    cancel: (r) => cancelRun(state.gh, view, r),
    retry: (r) => retryRun(state.gh, view, r),
    redispatch: (r) => redispatch(state.gh, view, r),
    confirm: (m) => window.confirm(m),
  } : undefined;
  const cancel = !serviceRunsMode && state.login === OPERATOR
    ? (r: Parameters<typeof cancelLiveRun>[1]) => actionButton("Cancel", "Cancel", { item: r.item ?? r.title, kind: r.kind ?? "agent", pool: r.pool ?? "", run: r.run }, () => cancelLiveRun(state.gh, r), (m) => window.confirm(m))
    : undefined;
  const live = liveAgentsView(serviceRunsMode ? serviceLiveRuns(state.serviceState, Date.now(), state.serviceStreamError) : state.liveRuns, serviceRunsMode ? undefined : state.passView, Date.now(), cancel);
  if (serviceRunsMode) live.prepend(h("p", { class: "note" }, `Service runs · generation ${state.serviceState?.generation ?? "unknown"} · read-only`));
  // A snapshot without a pass view says how old it is: an old one is a pass not publishing, not a setting.
  const at = state.active?.holds?.at;
  const missing = pass === undefined && at ? `Pass view not in the pass's snapshot, written ${ago(at, Date.now())}${stale(at, Date.now()) ? ": the pass may have stopped publishing it." : " (off or older producer)."}` : pass;
  state.home.slots.active.replaceChildren(serviceMode || state.serviceOnly ? serviceDecisionView(state.service, Date.now(), state.serviceError) : activePassView(missing, Date.now(), passUnavailable, actions, runPassControl(state.gh, facts, state.passControl ??= {}), live));
  state.home.slots.passes.replaceChildren(serviceMode || state.serviceOnly ? h("section", {}, h("h2", {}, "Scheduler passes"), h("p", { class: "note" }, "Pass history is not supplied by the service decision contract; unknown, not an empty history.")) : schedulerPassView(state.passes, pass, Date.now(), passUnavailable));
  if (serviceBoardMode) state.home.slots.passes.prepend(serviceBoardView(state.serviceState, Date.now(), state.serviceStreamError, state.serviceRepository, (repository) => {
    state.serviceRepository = repository;
    paintActive(state);
    // The repaint replaces the select; keep keyboard users on it.
    state.home?.el.querySelector<HTMLSelectElement>(".service-board select")?.focus();
  }));
  if (serviceRunsMode) state.home.slots.passes.prepend(live);
  state.home.slots.activity.replaceChildren(activityView(state.published, state.passes, Date.now(), passUnavailable));
  if (state.active?.repositories) state.repositories = state.active.repositories;
  const work = state.active?.passPublicationError ? undefined : state.active?.holds;
  state.home.slots.today.replaceChildren(todayView(work?.today, Date.now(), passUnavailable));
  state.home.slots.focus.replaceChildren(focusView(work?.epicFocus, Date.now(), passUnavailable, state.login));
  if (!passUnavailable || work) state.repositoryWork = { work: work?.dispatchableWork, at: work?.at };
  state.home.slots.repositories.replaceChildren(repositoriesView(state.repositories ?? [], Date.now(), unavailable, {
    ...state.repositoryWork, pass, unavailable: passUnavailable,
  }));
  fillStatus(state.home, state.active?.status === undefined ? undefined : model.status, render, state.serviceOnly ? "Project status needs a viewer's GitHub token; it is not supplied by the service decision contract." : state.active?.statusError, Date.now(), state.active?.board);
  fillState(state.home, model);
}

/**
 * The sources of the state `get` returns (a getter: the state holds the
 * layer), and the views that show them. The publication is the poll
 * loop's own read, including behind an entry for header counts. Status
 * is read only on its page, people only with their opt-in fold open.
 */
function newLayer(get: () => State): SourceLayer<ViewId> {
  return new SourceLayer<ViewId>(
    [
      { name: "inbox", path: "the pass's published inbox", cadence: POLL_INTERVAL_MS, views: VIEWS },
      { name: "status", path: "published project status", cadence: OPS_POLL_INTERVAL_MS, views: ["status"], when: () => !get().serviceOnly, read: async () => {
        const state = get();
        const status = await readSource(state.sources, "status", () => loadProjectStatus(state.gh));
        if (state.closed) return false;
        state.active ??= { at: Date.now(), warnings: [] };
        if (status !== undefined) state.active.status = status;
        else state.active.statusError = state.sources.status?.error ?? "Status unavailable";
        paintActive(state);
        return status !== undefined;
      } },
      { name: "live", path: "the agent workflows' unfinished runs (Actions API)", cadence: LIVE_POLL_MS, views: ["inbox"], when: () => !serviceMode && !serviceRunsMode && !get().serviceOnly, read: () => refreshLive(get()) },
      { name: "people", path: "search of issues and PRs asking for you", cadence: POLL_INTERVAL_MS, views: [SECTION_VIEW.needs], read: () => refreshPeople(get()), when: () => !get().serviceOnly && !!get().home?.el.querySelector<HTMLDetailsElement>("#sec-people")?.open },
      { name: NEEDS_HUMAN_LABEL, path: `search: ${NEEDS_HUMAN_QUERY}`, cadence: POLL_INTERVAL_MS, views: ["inbox"], read: () => refreshNeedsHuman(get()), when: () => !serviceMode && !get().serviceOnly && actNowGap(get().published, Date.now()) !== undefined },
    ],
    () => (get().closed ? undefined : visibleView(document, HOME_CLASS)),
  );
}

/** Read inbox context without the CLI's usage and operations telemetry. */
async function loadInboxContext(gh: GitHub): Promise<Active> {
  const sources: Sources = {};
  const publication = await readSource(sources, "holds", (source) => loadPassPublications(source), gh);
  const holds = publication?.holds;
  const active: Active = { at: Date.now(), sources, warnings: Object.entries(sources).flatMap(([name, source]) => source.error ? [`Couldn't read ${name}: ${source.error}`] : []) };
  if (holds) active.holds = holds;
  if (publication) {
    active.repositories = publication.repositories;
    active.passes = publication.passes ?? null;
    active.passPublicationError = publication.uncertain;
  }
  return active;
}

/**
 * What a read of the pass's snapshot says of its needs-you list. A list
 * read before stays, its cards marked unavailable, while a later read has
 * none to use; with none ever read, the snapshot's own operator holds are
 * shown, so they aren't dropped with the list.
 */
function readPublished(prev: Published, active: Active): Published {
  const source = active.sources?.holds;
  const kept: Published = prev.list
    ? { asks: [...prev.asks.filter((a) => !prev.holds?.some((h) => h.key === a.key)), ...(prev.holds ?? [])], list: prev.list, ...(prev.checkedAt === undefined ? {} : { checkedAt: prev.checkedAt }), unavailable: true }
    : { asks: prev.asks, unavailable: prev.asks.length > 0 };
  if (source?.state === "unavailable") return { ...kept, error: `Couldn't read the pass's snapshot: ${source.error ?? "no reason given"}` };
  const read = firstPublished(active.holds, source?.state === "ok" ? source.checkedAt : undefined);
  // Without a list, a first read's asks are the snapshot's own operator holds.
  return read.list || !prev.list ? read : { ...kept, error: read.error!, holds: read.asks };
}

/**
 * Re-read board context, heartbeat, holds and the published status,
 * and only while the page shows. The first time, what the cache has
 * shows first. False if not all of it was read (see SourceDef.read).
 */
async function refreshActive(state: State): Promise<boolean> {
  if (serviceMode || state.serviceOnly) {
    applyService(state);
    return !state.serviceError && !!state.service;
  }
  if (state.activeRunning) return false;
  state.activeRunning = true;
  try {
    if (!state.active) {
      const cached = state.gh.cacheOnly();
      const active = await loadInboxContext(cached);
      // History is independent of holds, including on a cold cache-only startup.
      const passes = state.passes.data ? undefined : readPasses(state.passes, active);
      if (passes?.data) state.passes = passes;
      if (!state.active && active.holds) {
        active.at = cached.oldest ?? active.at;
        active.fromCache = true;
        state.active = active;
        // A cached list shows at once, said to be the cache's; a cache miss says nothing yet.
        if (typeof active.holds?.needsYou === "object" && !state.published.list) state.published = readPublished(state.published, active);
        paintActive(state);
        paintNeeds(state);
      } else if (passes?.data) paintActive(state);
    }
    const active = await loadInboxContext(state.gh);
    if (state.closed) return false;
    state.active = { ...active, ...(state.active?.status === undefined ? {} : { status: state.active.status }) };
    state.published = readPublished(state.published, active);
    state.passes = readPasses(state.passes, active);
    paintActive(state);
    paintNeeds(state);
    return Object.values(active.sources ?? {}).every((s) => s.state !== "unavailable");
  } finally {
    state.activeRunning = false;
  }
}

/** Every panel consumes one generation, including on partial/full-resync reads. */
function applyService(state: State): void {
  const d = state.service;
  const error = state.serviceError ?? (d ? serviceProblem(d, Date.now()) : "Service decision unavailable");
  const checkedAt = d?.readAt ? Date.parse(d.readAt) : undefined;
  const active: Active = { at: checkedAt ?? Date.now(), warnings: [], sources: { holds: { state: error ? "unavailable" : "ok", ...(checkedAt === undefined ? {} : { checkedAt }), ...(error ? { error } : {}) } }, ...(d ? { holds: d.holds } : {}) };
  state.active = active;
  // Do not retain one generation's needs-you list beside another's work/pools.
  state.published = firstPublished(d?.holds, error ? undefined : checkedAt);
  if (error) state.published = { ...state.published, unavailable: true, error };
  state.passes = {};
  state.passView = undefined;
  delete state.repositoryWork;
  paintActive(state);
  paintNeeds(state);
}

/** The item `#item/<id>` opens: a board item, or a decision's issue that is not on the board. */
function routedItem(state: State, id: string): Item | undefined {
  return findRouteItem([...state.items, ...state.linked, ...(state.active?.board ?? []), ...(state.decisions?.map((d) => d.item) ?? [])], id)
    ?? (state.routed?.id === id ? state.routed.item : undefined);
}

/** Rebuild the whole view for the current route. */
function renderRoute(state: State): void {
  if (state.closed) return;
  delete state.shown;
  delete state.shownPr;
  delete state.itemNote;
  state.pane?.dispose();
  delete state.pane;
  renderChrome(state);
  const r = route();
  // Explicit item links have their own read; a failed queue must not block it.
  if (!state.loaded && r.route === "home") {
    showMain(h("p", { class: "empty" }, "Loading…"));
    return;
  }
  if (window.location.hash === "#state.json") {
    showMain(h("main", { class: "state-export" }, h("a", { href: "#", class: "back" }, "← Back"), h("h2", {}, "state.json"), h("pre", { id: "state-json" }, JSON.stringify(snapshot(state), null, 2))));
    return;
  }
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
    const pending = state.routed?.id === r.id ? state.routed : (state.routed = { id: r.id });
    showMain(h("main", {}, h("a", { href: "#", class: "back" }, "← Back"),
      h("p", { class: pending.error ? "error" : "empty", role: pending.error ? "alert" : "status" }, pending.error ?? "Loading item…")));
    if (!pending.error && !pending.loading) {
      // Mark the read before starting it, so queue refreshes don't duplicate it.
      pending.loading = true;
      void loadRouteItem(state.gh, r).then((loaded) => { pending.item = loaded; }, (e: unknown) => {
        pending.error = `Couldn't read this item: ${message(e)} Press r to retry.`;
      }).then(() => {
        const current = route();
        if (!state.closed && state.routed === pending && current.route === "item" && current.id === r.id) {
          // The queue may have opened the item while this read was in flight.
          if (state.shown) update(state, false, false);
          else renderRoute(state);
        }
      });
    }
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
  const dispatchKey = item.ref && item.state === "open" && state.login === OPERATOR ? refKey(item.ref) : undefined;
  const dispatch = dispatchKey
    ? itemDispatchControl(state.gh, dispatchKey, () => state.passView, (state.itemDispatch ??= new Map()).get(dispatchKey) ?? state.itemDispatch.set(dispatchKey, {}).get(dispatchKey)!)
    : undefined;
  showMain(
    itemView(
      item,
      { action, context: ctx, state: answerState(item, state.sent, answered), asks, hooks: contextHooks(state, item), labelOf: labelOf(state), dispatch },
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
      reviewed(state, ref, detail.head, action, url, found);
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

/**
 * Apply his review of `ref` at `head`, sent from its pane or an Inbox
 * card, to the page, and tell the bot on its review ask (`found`).
 */
function reviewed(state: State, ref: IssueRef, head: string, action: ReviewAction, url: string, found: ReturnType<typeof reviewAskFor>): void {
  const key = refKey(ref);
  state.reviewed.set(key, head);
  // Show its effect now: search and the reviews API lag a write.
  const verdict = REVIEW_VERDICT[action];
  if (verdict) {
    state.pending.set(key, { state: verdict, head, at: Date.now() });
    // Read its reviews again on the next poll, even before search notices.
    state.verdicts.delete(key);
    // A PR listed for what waits on him has no verdict overlay: apply the review to its wait (and again after each read).
    state.waiting = overlayWaiting(state.waiting, state.pending, Date.now());
  }
  // Tell the bot on its review ask. The review went out either way.
  const note = found ? reviewComment(action, ref, head, url) : undefined;
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
}

/** "" and "#" are both the bare page. */
const sameHash = (a: string, b: string) => a.replace(/^#$/, "") === b.replace(/^#$/, "");

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
  const origin = state.origin ?? needsOrigin(state, "#");
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
      moveOn(state, decision.to.href, `Done: ${done.title} → ${decision.to.title}`, done.hash);
      return;
    case "caught-up":
      moveOn(state, origin.hash, `Done: ${done.title}. All caught up.`, done.hash);
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
  if (routeItemId(state) !== item.nodeId) return;
  const container = byId("view").querySelector(`.${CONTEXT_CLASS}`);
  container?.replaceChildren(contextView(item, ctx, render, contextHooks(state, item)));
}

/** "Needs you" as a list to step through: questions are answered in place, the rest open. */
function needsOrigin(state: State, hash: string): Origin {
  return { hash, stops: needStops(state.needs), live: () => needStops(currentNeeds(state)) };
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
  // Deep links can already hold unsent text before the first queue read returns.
  const openEntry = (r.route === "item" && state.shown) || (r.route === "pr" && state.shownPr);
  if (first && !openEntry) {
    renderRoute(state);
  } else if (r.route === "home") {
    // The page stays as it is; only the lists that follow the queue are redrawn.
    if (state.home?.el.isConnected) {
      paintNeeds(state);
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
  state.layer.tick();
  const ok = await refreshActive(state);
  if (!current()) return;
  state.loaded = true;
  if (ok) {
    state.lastPoll = new Date();
    state.layer.checked("inbox");
  }
  // A source gated on what this read found (the direct needs-human read) starts now, not a poll later.
  tickSources(state);
  if (route().route === "home" && !state.home?.el.isConnected) renderRoute(state);
  else renderChrome(state);
}

/** Revalidate the publication now after an action, without target discovery. */
function refreshSoon(state: State): void {
  state.poller.now();
}

/** The poll loop's delay now: the usual interval, or longer and why under the rate budget. */
function delayNow(state: State): Delay {
  return pollDelay(state.gh.rate, Date.now(), { interval: POLL_INTERVAL_MS, backoff: POLL_BACKOFF_FACTOR, lowFraction: RATE_LOW_FRACTION, clock }, state.gh.blockedUntil);
}

/**
 * Start the due sources of the view on screen off the poll (on showing
 * a view, or opening a section): unless the rate budget slowed or paused
 * the poll, as the sources then wait for it.
 */
function tickSources(state: State): void {
  if (delayNow(state).why === undefined) state.layer.tick();
}

/** The poll loop of the state `get` returns (a getter: the state holds the loop). */
function newPoller(get: () => State): Poller {
  return new Poller({
    run: (current) => poll(get(), current),
    delay: () => delayNow(get()),
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
        // The view's sources are re-read too, now rather than when due; a reload on request in the inbox drops the needs rows' unsent picks, as the note warned (the decisions document keeps its own), but not from another view, where they are out of sight.
        state.layer.tick(true);
        if (state.view === SECTION_VIEW.needs) paintNeeds(state, true);
      }
      if (r.route === "item") {
        delete state.routed;
        renderRoute(state);
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
    case "status":
      window.location.hash = viewHash("status");
      return;
    default:
      if (cmd === "section:needs") jumpTo(state);
  }
}

/** Switch to the inbox, open "Needs you" and scroll to it. */
function jumpTo(state: State): void {
  if (!state.home) return;
  state.view = "inbox";
  showView(state.home.el, "inbox");
  window.location.hash = "#inbox";
  state.home.sections.needs.details.open = true;
  tickSources(state);
  state.home.sections.needs.details.scrollIntoView?.({ block: "start" });
  // The first row of it, so j/k go on from there.
  const first = state.home.sections.needs.details.querySelector<HTMLElement>(`.${ROW_CLASS}`);
  if (first) {
    state.selected = rowId(first);
    markSelected(state, false);
  }
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
    state.stopService?.();
    for (const d of state.itemDispatch?.values() ?? []) d.stopped = true;
    if (state.chat?.attached()) keptChat = state.chat;
    else state.chat?.dispose();
    viewClosed = true;
    state.poller.close();
    clearInterval(state.metaTicker);
    state.pane?.dispose();
    state.rejecting = Promise.allSettled([forgetCache(state.session, () => deleteCacheDatabase()), state.source.signOut()]).then(() => showSignIn("rejected"));
  }
  return state.rejecting;
}

async function start(source: TokenSource, serviceOnly = false): Promise<void> {
  const session = await openCache(await source.get(), source.persistence === "local", () => IdbStore.open(), () => deleteCacheDatabase());
  // The view the page opens in, so the navigation marks it while loading.
  const opened = route();
  const state: State = {
    serviceOnly,
    sources: {},
    layer: newLayer(() => state),
    view: (opened.route === "home" && opened.view) || DEFAULT_VIEW,
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
    needs: [],
    answeredHere: new Set(),
    activeRunning: false,
    decisionsAnswered: new Set(),
    published: { asks: [], unavailable: false },
    passes: {},
  };
  state.gh.onUnauthorized = () => void rejected(state);
  state.gh.readOnly = true;
  byId("meta").textContent = "Checking the token…";
  // This token was used here before: show what it saw last time, as the
  // login it had then, while GitHub confirms it.
  if (session.knownLogin) state.login = session.knownLogin;
  const cached = Promise.resolve();
  try {
    if (!serviceOnly) state.login = await viewer(state.gh);
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
    state.tokenWarning = `This token lacks the ${lacking.map((n) => n.any.join(" or ")).join(", ")} scope${lacking.length > 1 ? "s" : ""}; some reads will fail.`;
  }
  byId("signout").hidden = false;
  const writes = byId("writes");
  // Service previews never vouch for a write, even beside a viewer's token.
  writes.hidden = serviceMode || serviceOnly;
  writes.textContent = "Read-only · Enable writes";
  writes.onclick = () => {
    if (state.closed) return;
    if (state.gh.readOnly && !window.confirm("Enable GitHub writes for this page session? Actions use this token's permissions and still require their own checks. Reloading returns to read-only.")) return;
    state.gh.readOnly = !state.gh.readOnly;
    writes.textContent = state.gh.readOnly ? "Read-only · Enable writes" : "Writes enabled · Make read-only";
  };
  byId("views").hidden = false;
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
    state.stopService?.();
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
        state.origin = needsOrigin(state, "#inbox");
      } else if (came !== "item" && came !== "pr") delete state.origin;
    }
    // Shown before this route renders: the view switched to, unless a jump already showed it.
    const shownView = state.home?.el.isConnected ? state.home.el.getAttribute(VIEW_ATTR) : undefined;
    renderRoute(state);
    // Back on the page from an entry, he is on the row he left; picking a filter leaves him where he is; another view starts at its top.
    if (to === "home" && came !== "home") markSelected(state, true);
    else if (to !== "home" || (shownView && shownView !== state.view)) window.scrollTo(0, 0);
  });
  installKeys(state);
  installAdvance(state);
  // Mobile Safari suspends a page in the background, often without a
  // visibilitychange on return; any of these may be the first sign of it.
  document.addEventListener("visibilitychange", () => state.poller.visibilityChanged(frozenSince(state)));
  window.addEventListener("pagehide", () => {
    state.poller.suspend();
    state.stopService?.();
    delete state.stopService;
    state.serviceStreamError = "Service stream unavailable; waiting for full resync";
    if (serviceMode) state.serviceError = state.serviceStreamError;
    if (serviceMode || serviceOnly) applyService(state);
    else if (serviceRunsMode || serviceBoardMode) paintActive(state);
  });
  for (const ev of ["pageshow", "focus"]) window.addEventListener(ev, () => { subscribeService(); state.poller.wake(frozenSince(state)); });
  state.metaTicker = setInterval(() => {
    state.tickedAt = Date.now();
    if (state.loaded && !document.hidden) {
      renderChrome(state);
      // Waiting ages move on without a redraw of the rows.
      tickAges(document.body, Date.now());
      // Clocks age without a push; don't redraw a filter the viewer is choosing in.
      if ((serviceRunsMode || serviceBoardMode) && !document.activeElement?.closest(".service-board")) paintActive(state);
    }
  }, META_TICK_MS);
  await cached;
  function subscribeService(): void {
    if (state.closed || state.stopService || !serviceStream) return;
    state.stopService = watchServiceState((full, error) => {
      if (state.closed) return;
      if (full) state.serviceState = full;
      state.serviceStreamError = error;
      if (serviceMode) {
        if (full?.decision) state.service = full.decision;
        else if (full) delete state.service;
        state.serviceError = error ?? full?.decisionError;
      }
      state.loaded = true;
      if (serviceMode || serviceOnly) applyService(state);
      else paintActive(state);
      if (!state.home?.el.isConnected) renderRoute(state);
    });
  }
  subscribeService();
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
    state.chat = chatPanel(state.gh);
    state.chat?.mount(byId("chat"));
  }
  keptChat = undefined;
  paintInbox(state, false);
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
        "Start with a short-lived read-only fine-grained token for the repositories you want to read: Issues, Pull requests, Actions, Contents and Commit statuses: read. Private publications need access to their repository. The app starts read-only even if your token can write. Enable writes in the More menu only when you intend to act; reloading turns them off. A classic token uses these scopes:",
      ),
      scopeList(),
      h("p", {}, "Classic tokens can read public repositories without a repository scope; private repositories require repo. For writes, comments and reviews need public_repo (or repo for private repositories), and workflow dispatch needs repo. Fine-grained tokens need the relevant Issues, Pull requests or Actions write permission on the target repository. Enabling writes does not grant permissions to your token; use Sign out to replace it if an action reports missing access."),
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
  byId("writes").hidden = true;
  byId("views").hidden = true;
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

/** The ⋯ menu holding the header's controls. */
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
  else if (serviceStream) await start({ get: async () => "", signOut: async () => {}, persistence: "session" }, true);
  else showSignIn("none");
}

main().catch((e: unknown) => {
  setNotice(`The app failed to start: ${e instanceof Error ? e.message : String(e)}`);
});
