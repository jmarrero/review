// The item view and the "By priority" list, built with plain DOM calls.
// Rendered markdown comes from the sanitizing renderer as a DocumentFragment.

import { type Answer, parseAnswer, parseBlocks, type Question, unfencedLines } from "../answer.ts";
import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { commentNote, type ItemAction, parseAskBody } from "./asks.ts";
import { authorLabel } from "./authors.ts";
import { ASK_LABELS, askKind, type IssueRef, isAsk, isQuestion, type Item, questionOf, type SubIssueSummary } from "./board.ts";
import type { Context, RunStatus, SubIssue } from "./backend.ts";
import { BOARD_URL, OPERATOR } from "./config.ts";
import { ALL, applyFilter, type Chip, chips, filterText, filterToken, type QueueFilter } from "./filter.ts";
import { type Entry, type EntryKind, groupRanked, onBot } from "./queue.ts";

/** Characters of Why shown on a queue row. */
const WHY_EXCERPT = 160;

function refLabel(item: Item): string {
  if (item.ref) return `${item.ref.owner}/${item.ref.repo}#${item.ref.number}`;
  return item.kind === "draft" ? "draft item" : "item";
}

export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A time of day, hours and minutes, the locale's way (12 or 24 h): the one format every clock time uses. "" for a bad time. */
export function clock(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function time(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
  if (Number.isNaN(t)) return "";
  const ms = Math.max(0, now - t);
  for (const [unit, suffix] of AGE_UNITS) if (ms >= unit) return `${Math.floor(ms / unit)}${suffix}`;
  return "now";
}

/**
 * An age's tooltip. A board item that isn't an ask ages from the board
 * item's last change (see waitingSince), an upper bound on when it began
 * to wait, so it says so rather than "waiting since".
 */
export function sinceTitle(e: Entry | undefined, since: string | undefined, waiting = "waiting since"): string {
  if (!since) return "";
  return e?.kind === "item" ? `board item last changed ${time(since)}` : `${waiting} ${time(since)}`;
}

export function pill(priority: string | undefined): HTMLElement {
  const p = priority ?? "–";
  return h("span", { class: `pill ${/^P[0-3]$/.test(p) ? p.toLowerCase() : "pn"}` }, p);
}

export type AnswerState = "answered" | "done" | undefined;

/**
 * Where an ask stands: done once the bot closed it; answered once sent
 * from this tab or he commented after the bot last did (`answered`, by
 * node id), until the bot acts. Other items take no answers, so have no
 * state.
 */
export function answerState(item: Item, sent: ReadonlySet<string>, answered: ReadonlySet<string>): AnswerState {
  if (!isAsk(item)) return undefined;
  if (item.state === "closed") return "done";
  return sent.has(item.nodeId) || answered.has(item.nodeId) ? "answered" : undefined;
}

export const STATE_LABEL: Record<NonNullable<AnswerState>, string> = {
  answered: "answered, waiting on the bot",
  done: "closed by the bot",
};

/** Sub-issue progress, e.g. "1/3 sub-issues done". */
export function progressText(p: SubIssueSummary): string {
  return `${p.completed}/${p.total} sub-issues done`;
}

/** A short status shown on a queue row, e.g. "answered". */
export interface RowLabel {
  text: string;
  cls: string;
}

export const KIND_LABEL: Record<EntryKind, string> = { pr: "PR", question: "Q", review: "rev", chore: "do", item: "item" };
export const KIND_TITLE: Record<EntryKind, string> = {
  pr: "PR waiting on you (or, last, on the bot)",
  question: "question for you",
  review: "PR the bot asks you to review",
  chore: "something the bot asks you to do",
  item: "board item",
};

/** The label on a Needs human item the bot left without an ask. */
export const BUG_LABEL = "no ask from the bot (bot bug)";

/** The class list rows carry, and the attribute holding their key. */
export const ROW_CLASS = "row";
export const ROW_KEY_ATTR = "data-key";
/** The attribute naming the section a row is in, and the one holding the route it opens (articles; links have an href). */
export const ROW_SECTION_ATTR = "data-section";
export const ROW_HREF_ATTR = "data-href";

/** What an ask asks, in one line: a question's `Q:`, a review's or chore's `Ask:`. */
export function askText(item: Item): string | undefined {
  const kind = askKind(item);
  if (kind === "question") return questionOf(item).ask;
  return kind ? parseAskBody(item.body).ask : undefined;
}

/** The row's one-line summary: what an ask asks, else Why. */
export function rowText(e: Entry): string {
  const text = (e.item ? askText(e.item) : undefined) ?? e.item?.why ?? "";
  return text ? excerpt(text, WHY_EXCERPT) : "";
}

function row(e: Entry, labelOf: (e: Entry) => RowLabel | undefined, now: number, child: boolean): HTMLElement {
  const label = labelOf(e);
  const why = rowText(e);
  const progress = e.item?.subIssues ? progressText(e.item.subIssues) : undefined;
  const where = [e.item?.org, e.where, e.blocks ? `blocks ${e.blocks}` : undefined, progress].filter(Boolean).join(" · ");
  return h(
    "a",
    { class: `${ROW_CLASS} k-${e.kind}${child ? " child" : ""}${label ? ` ${label.cls}` : ""}`, href: e.href, [ROW_KEY_ATTR]: e.key, [ROW_SECTION_ATTR]: "priority" },
    h("span", { class: `kind k-${e.kind}`, title: KIND_TITLE[e.kind] }, KIND_LABEL[e.kind]),
    h(
      "span",
      { class: "main" },
      h("span", { class: "title" }, e.title),
      h(
        "span",
        { class: "sub" },
        pill(e.priority),
        h("span", { class: "tag" }, where),
        label ? h("span", { class: `state ${label.cls}` }, label.text) : null,
        e.bug ? h("span", { class: "state bug" }, BUG_LABEL) : null,
      ),
      why ? h("span", { class: "why" }, why) : null,
    ),
    h("span", { class: "age", title: sinceTitle(e, e.since), ...(e.since ? { [SINCE_ATTR]: e.since } : {}) }, age(e.since, now)),
  );
}

/** On an age label the page's ticker moves on (tickAges): the time it counts from. */
export const SINCE_ATTR = "data-since";

/**
 * Move every ticking age under `root` to `now`, in place: the queue is
 * redrawn only when it changes, so without this a row's age sits at the
 * time of the last change. An age with nothing to count from keeps its
 * text ("age unknown").
 */
export function tickAges(root: ParentNode, now: number): void {
  for (const el of root.querySelectorAll<HTMLElement>(`.age[${SINCE_ATTR}]`)) {
    const text = age(el.getAttribute(SINCE_ATTR) ?? undefined, now);
    if (text) el.textContent = text;
  }
}

/** A filter chip: a link to the queue filtered so, with its row count. */
function chip(c: Chip, cls: string): HTMLElement {
  const attrs: Record<string, string> = { class: `chip ${cls}${c.on ? " on" : ""}`, href: `#${filterToken(c.filter)}` };
  if (c.title) attrs.title = c.title;
  if (c.on) attrs["aria-current"] = "true";
  return h("a", attrs, c.label, h("span", { class: "count" }, String(c.count)));
}

/** Set on the filter bar while folded; only a narrow screen's stylesheet acts on it. */
export const FILTERS_FOLDED_CLASS = "folded";

/** Whether he unfolded the filter bar: kept across the queue's re-renders, not across reloads. */
let filtersOpen = false;

/**
 * The presets, then one chip per target organization and per priority.
 * A narrow screen folds them behind one "Filters (active: …)" button.
 */
function filterBar(entries: readonly Entry[], filter: QueueFilter): HTMLElement {
  const { presets, orgs, priorities } = chips(entries, filter);
  const line = (label: string, list: Chip[], cls: string) =>
    h("div", { class: "chips" }, h("span", { class: "chips-h" }, label), h("div", { class: "chips-list" }, ...list.map((c) => chip(c, cls))));
  const toggle = h("button", { type: "button", class: "small filters-toggle" }, `Filters (active: ${filterText(filter)})`);
  const bar = h(
    "nav",
    { class: "filters", "aria-label": "Filter the queue" },
    toggle,
    line("Show", presets, "preset"),
    line("Org", orgs, "org"),
    line("Priority", priorities, "prio"),
  );
  const show = () => {
    bar.classList.toggle(FILTERS_FOLDED_CLASS, !filtersOpen);
    toggle.setAttribute("aria-expanded", String(filtersOpen));
  };
  toggle.addEventListener("click", () => {
    filtersOpen = !filtersOpen;
    show();
  });
  show();
  return bar;
}

/** The class of the "all caught up" line. */
export const CAUGHT_UP_CLASS = "caught-up";

/** The class of the note listing board items the queue dropped as closed. */
export const STALE_NOTE_CLASS = "stale-items";

/** What the list shows around its entries. */
export interface ListExtras {
  /** Board items dropped because their issue or PR is closed or merged (see staleItems), named at the end. */
  stale?: readonly Item[];
}

/** A folded note naming the board items whose Status is behind their closed issue or PR. */
function staleNote(stale: readonly Item[]): HTMLElement {
  const n = stale.length;
  return h(
    "details",
    { class: `fine ${STALE_NOTE_CLASS}` },
    h("summary", {}, `Not listed: ${n} board item${n === 1 ? "" : "s"} closed or merged, yet still Draft or Needs human on the board`),
    h("p", {}, "The board is behind GitHub here; the bot should move ", n === 1 ? "it" : "them", " to Done."),
    h("ul", {}, ...stale.map((i) => h("li", {}, link(i.url, refLabel(i)), ` ${i.status ?? ""}: ${i.title}`))),
  );
}

/**
 * Every entry of the queue, ranked and grouped by priority, with the
 * org and priority filters: the body of the "By priority" section.
 */
export function priorityList(
  all: readonly Entry[],
  labelOf: (e: Entry) => RowLabel | undefined,
  now: number = Date.now(),
  filter: QueueFilter = ALL,
  extras: ListExtras = {},
): HTMLElement {
  const root = h("div", { class: "queue" });
  const stale = extras.stale?.length ? staleNote(extras.stale) : null;
  if (all.length === 0) {
    root.append(h("p", { class: "empty" }, "Nothing is listed: no PR, question or board item waits on you or the bot."));
    if (stale) root.append(stale);
    return root;
  }
  root.append(filterBar(all, filter));
  const entries = applyFilter(all, filter);
  if (entries.length === 0) {
    root.append(h("p", { class: "empty" }, "Nothing here matches this filter. ", h("a", { href: `#${filterToken(ALL)}` }, "Show all")));
    if (stale) root.append(stale);
    return root;
  }
  const counts = { pr: 0, question: 0, review: 0, chore: 0, item: 0 };
  let bugs = 0;
  let botTurn = 0;
  for (const e of entries) {
    if (e.bug) bugs++;
    if (onBot(e)) botTurn++;
    for (const x of [e, ...(e.children ?? [])]) if (!x.settled && !onBot(x)) counts[x.kind]++;
  }
  const parts = [`${counts.pr} PRs`, `${counts.question} questions`, `${counts.review} reviews`, `${counts.chore} chores`];
  if (bugs) parts.push(`${bugs} without an ask`);
  if (botTurn) parts.push(`${botTurn} PRs waiting on the bot`);
  root.append(h("p", { class: "summary queue-summary" }, parts.join(" · ")));
  for (const group of groupRanked(entries)) {
    const count = group.entries.reduce((n, e) => n + 1 + (e.children?.length ?? 0), 0);
    const section = h("section", { class: "group" }, h("h2", { class: "group-h" }, `${group.priority} · ${count}`));
    for (const e of group.entries) {
      section.append(row(e, labelOf, now, false));
      for (const c of e.children ?? []) section.append(row(c, labelOf, now, true));
    }
    root.append(section);
  }
  if (stale) root.append(stale);
  return root;
}

export interface ItemViewHandlers {
  /** Post an answer to a question; resolves to the comment's URL. */
  send(answer: Answer): Promise<string>;
  /** Post his comment on a review or chore; resolves to its URL. */
  comment(text: string): Promise<string>;
  /** Rerun a run's failed jobs; resolves to the URL of the comment saying so. */
  rerun(runUrl: string): Promise<string>;
}

function where(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** What sending does, under the send button. */
export function describeTarget(ref: IssueRef): string {
  return `Posts a comment as you on ${where(ref)}; the bot acts on it and closes the issue.`;
}

/** Wire a form's submit to `send`, with a status line; the button stays off after it went out. */
function sendingForm(form: HTMLElement, button: HTMLButtonElement, status: HTMLElement, send: () => Promise<string> | undefined): void {
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const sending = send();
    if (!sending) return;
    button.disabled = true;
    status.textContent = "Sending…";
    sending
      .then((url) => {
        status.textContent = "Sent: ";
        status.append(link(url, url));
        // The button stays disabled: one tap, one answer. What's left in
        // the form was sent, so it's no draft (see decisionDraft).
        form.dataset.sent = "true";
      })
      .catch((e: unknown) => {
        status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
        button.disabled = false;
      });
  });
}

/**
 * The answer form for a question: its options as radio buttons, the
 * recommended one marked (never picked for him), and his own text.
 * `idPrefix` keeps element ids unique when a page shows several forms;
 * `rows` is the height of the text box.
 */
export function answerForm(ref: IssueRef, question: Question, answered: boolean, send: (answer: Answer) => Promise<string>, idPrefix = "", rows = 4): HTMLElement {
  const { options } = question;
  const form = h("form", { class: "answer" });
  const status = h("p", { class: "status", role: "status" });
  if (options.length) {
    const fs = h("fieldset", {}, h("legend", {}, "Choose"));
    for (const o of options) {
      const id = `${idPrefix}opt-${o.letter}`;
      fs.append(
        h(
          "label",
          { class: "opt", for: id },
          h("input", { type: "radio", name: "choice", id, value: o.letter }),
          h("span", {}, h("b", {}, `${o.letter}) `), o.text, o.recommended ? " " : null, o.recommended ? h("span", { class: "rec" }, "recommended") : null),
        ),
      );
    }
    form.append(fs);
  }
  const text = h("textarea", {
    name: "text",
    rows: String(rows),
    placeholder: options.length ? "Anything to add (optional)" : "Your answer",
    "aria-label": "Answer text",
  });
  const button = h("button", { type: "submit", class: "primary" }, "Send answer");
  let sent = answered;
  form.append(text, h("p", { class: "target" }, describeTarget(ref)), h("div", { class: "actions" }, button), status);
  sendingForm(form, button, status, () => {
    const picked = form.querySelector<HTMLInputElement>("input[name=choice]:checked");
    const answer: Answer = { text: text.value };
    if (picked) answer.choice = picked.value;
    if (!picked && !text.value.trim()) {
      status.textContent = "Pick an option or write an answer.";
      text.focus();
      return undefined;
    }
    if (sent && !window.confirm("You already answered this. Send another answer?")) return undefined;
    return send(answer).then((url) => {
      sent = true;
      return url;
    });
  });
  return form;
}

/** A comment box for a review or chore: his words, finishing the ask. */
function commentForm(ref: IssueRef, answered: boolean, placeholder: string, handlers: ItemViewHandlers): HTMLElement {
  const form = h("form", { class: "answer comment-ask" });
  const status = h("p", { class: "status", role: "status" });
  const text = h("textarea", { name: "text", rows: "3", placeholder, "aria-label": "Comment text" });
  const button = h("button", { type: "submit", class: "primary" }, "Send comment");
  let sent = answered;
  form.append(text, h("p", { class: "target" }, describeTarget(ref)), h("div", { class: "actions" }, button), status);
  sendingForm(form, button, status, () => {
    if (!text.value.trim()) {
      status.textContent = "Write a comment first.";
      text.focus();
      return undefined;
    }
    if (sent && !window.confirm("You already commented on this. Send another comment?")) return undefined;
    return handlers.comment(text.value).then((url) => {
      sent = true;
      return url;
    });
  });
  return form;
}

/** The app route of a PR's review pane. */
export function prRoute(ref: IssueRef): string {
  return `#pr/${ref.owner}/${ref.repo}/${ref.number}`;
}

const short = (sha: string) => sha.slice(0, 12);

/** "your answer", or "your answer: B" when it picks an option. */
function answerLabel(body: string): string {
  const { choice } = parseAnswer(body);
  return choice ? ` · your answer: ${choice}` : " · your answer";
}

function commentView(c: Context["comments"][number], render: Renderer, onAsk: "question" | "other" | undefined): HTMLElement {
  // On an ask, every comment of his is an answer.
  const isAnswer = onAsk !== undefined && c.author === OPERATOR;
  const label = !isAnswer ? "" : onAsk === "question" ? answerLabel(c.body) : " · your comment";
  return h(
    "article",
    { class: `comment${isAnswer ? " your-answer" : ""}` },
    h("div", { class: "meta" }, link(c.url, `${authorLabel(c.author)} · ${time(c.createdAt)}`), label),
    h("div", { class: "md" }, render(c.body)),
  );
}

/** The app route of an issue that is on the board, if it is. */
export type BoardHref = (ref: IssueRef) => string | undefined;

function subIssueView(s: SubIssue, boardHref: BoardHref): HTMLElement {
  const href = boardHref(s.ref);
  const kinds = Object.entries(ASK_LABELS).flatMap(([kind, label]) => (s.labels.includes(label) ? [kind] : []));
  const notes = [...kinds, s.progress ? progressText(s.progress) : ""].filter(Boolean).join(" · ");
  return h(
    "li",
    { class: `sub-issue ${s.state === "closed" ? "closed" : "open"}` },
    h("span", { class: "sub-state" }, s.state),
    " ",
    href ? h("a", { href }, s.title) : link(s.url, s.title),
    " ",
    h("span", { class: "tag" }, notes ? `${where(s.ref)} · ${notes}` : where(s.ref)),
  );
}

function subIssuesView(item: Item, subs: readonly SubIssue[], boardHref: BoardHref): HTMLElement {
  const summary = item.subIssues ? ` · ${progressText(item.subIssues)} (${item.subIssues.percent_completed}%)` : "";
  return h("section", { class: "sub-issues" }, h("h3", {}, `Sub-issues${summary}`), h("ul", {}, ...subs.map((s) => subIssueView(s, boardHref))));
}

/** A note when a run is on an older commit than the PR the chore blocks, else undefined. */
export function oldHeadNote(r: RunStatus): string | undefined {
  if (!r.headSha || !r.prHead || r.headSha === r.prHead) return undefined;
  return `This run is on ${r.headSha.slice(0, 12)}, an older head: the PR is now at ${r.prHead.slice(0, 12)}. Rerunning it tests old code.`;
}

/** One run to rerun (a chore's, or behind a PR's failed required check): its failed jobs, and the button, only when GitHub says it can be rerun. */
export function runView(r: RunStatus, hooks: ContextHooks): HTMLElement {
  const { run } = r;
  const { rerun } = hooks;
  const state = [r.status, r.conclusion, r.attempt ? `attempt ${r.attempt}` : "", r.headSha ? `on ${r.headSha.slice(0, 12)}` : ""].filter(Boolean).join(", ");
  const status = h("p", { class: "status", role: "status" });
  const button = h("button", { type: "button", class: "primary" }, "Rerun failed jobs");
  // A rerun still in flight (this view may be a fresh render of it) stays off.
  const inFlight = hooks.rerunning?.(run.url) === true;
  button.disabled = r.problem !== undefined || !rerun || inFlight;
  if (inFlight) status.textContent = "Rerunning…";
  const old = oldHeadNote(r);
  const jobs = r.failed.length
    ? h("ul", { class: "jobs" }, ...r.failed.map((j) => h("li", {}, link(j.url, j.name))))
    : h("p", { class: "tag" }, "No failed jobs in its latest attempt.");
  button.addEventListener("click", () => {
    if (!rerun || r.problem !== undefined || hooks.rerunning?.(run.url)) return;
    const names = r.failed.map((j) => j.name).join(", ");
    const commit = r.headSha ? ` on ${r.headSha.slice(0, 12)}` : "";
    const after = hooks.rerunOnPr ? "" : ", then comments on the chore so the bot knows";
    const ok = window.confirm(
      `Rerun the ${r.failed.length} failed job${r.failed.length === 1 ? "" : "s"} (${names}) of ${run.url}${commit}?${old ? `\n\n${old}` : ""}\n\nThis uses your token to write to ${run.owner}/${run.repo}${after}.`,
    );
    if (!ok) return;
    button.disabled = true;
    status.textContent = "Rerunning…";
    rerun(run.url)
      .then((url) => {
        status.textContent = hooks.rerunOnPr ? "Rerun started: " : "Rerun started; told the bot: ";
        status.append(link(url, url));
      })
      .catch((e: unknown) => {
        const why = e instanceof Error ? e.message : String(e);
        // It may have gone out: say so, and don't offer a blind retry.
        if (e instanceof Error && e.name === "MaybeSentError") {
          status.textContent = `Unsure whether it reran: ${why}.`;
          return;
        }
        status.textContent = `Not rerun: ${why}`;
        button.disabled = false;
      });
  });
  return h(
    "li",
    { class: "run" },
    link(run.url, `${run.owner}/${run.repo} run ${run.id}`),
    r.name ? ` · ${r.name}` : "",
    state ? h("span", { class: "tag" }, ` · ${state}`) : null,
    jobs,
    old ? h("p", { class: "warn" }, old) : null,
    r.problem ? h("p", { class: "note" }, `Can't rerun: ${r.problem}.`) : null,
    h("div", { class: "actions" }, button),
    status,
  );
}

/** Hooks the loaded context's parts act through. */
export interface ContextHooks {
  /** Links sub-issues on the board to their item view. */
  boardHref?: BoardHref;
  /** Rerun a run's failed jobs (a rerun chore's runs). */
  rerun?: (runUrl: string) => Promise<string>;
  /** Whether a rerun of this run is still in flight. */
  rerunning?: (runUrl: string) => boolean;
  /** The runs are a PR's failed required checks, not a chore's: nothing is commented. */
  rerunOnPr?: boolean;
}

/** The part of the item view that needs the loaded context. */
export function contextView(item: Item, context: Context | undefined, render: Renderer, hooks: ContextHooks = {}): DocumentFragment {
  const out = document.createDocumentFragment();
  if (!context) {
    out.append(h("p", { class: "note" }, "Loading comments, gists, sub-issues and runs…"));
    return out;
  }
  for (const w of context.warnings) out.append(h("p", { class: "warn" }, w));
  if (context.runs?.length) {
    out.append(h("section", { class: "runs" }, h("h3", {}, "Runs to rerun"), h("ul", {}, ...context.runs.map((r) => runView(r, hooks)))));
  }
  if (context.subIssues?.length) out.append(subIssuesView(item, context.subIssues, hooks.boardHref ?? (() => undefined)));
  for (const g of context.gists) {
    const s = h("section", { class: "gist" }, h("h3", {}, "Gist ", link(g.url, g.owner ? `by ${g.owner}` : "")));
    for (const f of g.files) {
      const isMarkdown = f.language === "Markdown" || /\.(md|markdown)$/i.test(f.name);
      s.append(
        h("h4", {}, f.name, f.truncated ? " (truncated)" : ""),
        isMarkdown ? h("div", { class: "md" }, render(f.content)) : h("pre", {}, f.content),
      );
    }
    out.append(s);
  }
  if (context.comments.length) {
    const s = h("section", { class: "comments" }, h("h3", {}, "Latest comments"));
    const onAsk = isQuestion(item) ? "question" : isAsk(item) ? "other" : undefined;
    for (const c of context.comments) s.append(commentView(c, render, onAsk));
    out.append(s);
  }
  return out;
}

/** The class of the element contextView fills, so it can be refreshed alone. */
export const CONTEXT_CLASS = "context";

/** What the item view shows besides the item. */
export interface ItemViewData {
  action: ItemAction;
  context: Context | undefined;
  state: AnswerState;
  /** The asks nested under this item in the queue. */
  asks?: readonly Entry[];
  hooks?: ContextHooks;
  /** Label each nested ask's state, as the queue does. */
  labelOf?: (e: Entry) => RowLabel | undefined;
}

const STATE_NOTE: Record<NonNullable<AnswerState>, string> = {
  answered: "You answered; it stays in the queue until the bot acts on it and closes the issue.",
  done: "The bot acted on this and closed it.",
};

/** The nested asks of an item, as actions to open. */
function asksView(asks: readonly Entry[], labelOf: ((e: Entry) => RowLabel | undefined) | undefined): HTMLElement {
  return h(
    "section",
    { class: "asks" },
    h("h3", {}, "What the bot asks of you"),
    h(
      "ul",
      {},
      ...asks.map((a) => {
        const label = labelOf?.(a);
        const text = a.item ? askText(a.item) : undefined;
        return h(
          "li",
          {},
          h("span", { class: `kind k-${a.kind}`, title: KIND_TITLE[a.kind] }, KIND_LABEL[a.kind]),
          " ",
          h("a", { href: a.href }, text ?? a.title),
          label ? h("span", { class: `state ${label.cls}` }, label.text) : null,
        );
      }),
    ),
  );
}

/** The action part of the item view: what he can do here, or why not. */
function actionView(item: Item, data: ItemViewData, handlers: ItemViewHandlers): (HTMLElement | null)[] {
  const { action, state } = data;
  const answered = state === "answered";
  const askLine = (text: string | undefined) => (text ? h("p", { class: "ask" }, h("b", {}, "Ask: "), text) : null);
  switch (action.kind) {
    case "answer":
      return [
        action.question.optionsProblem
          ? h("p", { class: "warn" }, `The question's options can't all be offered: ${action.question.optionsProblem}. Read the question below, and answer in your own words if an option is missing.`)
          : null,
        answerForm(action.ref, action.question, answered, (a) => handlers.send(a)),
      ];
    case "review":
      return [
        askLine(action.body.ask),
        h(
          "ul",
          { class: "review-asks" },
          ...action.body.reviews.map((r) =>
            h(
              "li",
              {},
              h("a", { href: prRoute(r.ref), class: "primary-link" }, `Review ${where(r.ref)} at ${short(r.head)}`),
              " ",
              link(r.url, "on GitHub"),
            ),
          ),
        ),
        h(
          "p",
          { class: "note" },
          "The review pane shows the head the bot asked about and warns if the PR moved since. Approving or requesting changes there also comments on this issue, so the bot sees it.",
        ),
        commentForm(action.ref, answered, "Or say something else (e.g. why not now)", handlers),
      ];
    case "rerun":
      return [
        askLine(action.body.ask),
        h("p", { class: "note" }, "The runs are listed below, each with its failed jobs; rerunning asks you first, then comments on this issue."),
        commentForm(action.ref, answered, "Or say something else", handlers),
      ];
    case "comment": {
      const note = commentNote(action);
      return [
        note ? h("p", { class: "warn" }, `The app can't offer this ${action.ask}'s action: ${note}. Comment instead, or act on GitHub.`) : null,
        askLine(action.body.ask),
        commentForm(action.ref, answered, "Your comment: done, or what you did or decided", handlers),
      ];
    }
    case "done":
      return [];
    case "blocked":
      return [h("p", { class: "warn" }, `The app can't act on this: ${action.reason}. Act on GitHub if it still needs you.`)];
    case "asks":
      return [data.asks?.length ? asksView(data.asks, data.labelOf) : null];
    case "bug":
      return [
        h(
          "p",
          { class: "warn bug" },
          "The bot left this without an ask: it is Needs human, but no open question, review or chore in the tracker names it. Its Why and links are here; tell the bot on GitHub, or ask it to file the ask.",
        ),
      ];
    case "read":
      return [h("p", { class: "note" }, "Ready for you to read or review: see the links, and any gist below.")];
  }
}

export function itemView(item: Item, data: ItemViewData, render: Renderer, handlers: ItemViewHandlers): HTMLElement {
  const { context, state } = data;
  const kind = askKind(item);
  const links = h("div", { class: "links" });
  if (item.url) links.append(link(item.url, kind || !item.ref ? refLabel(item) : `${refLabel(item)}: act on GitHub`));
  const blocks = kind ? parseBlocks(unfencedLines(item.body)) : undefined;
  if (blocks) links.append(link(blocks, "blocks"));
  for (const u of item.branch) links.append(link(u, "branch"));
  for (const u of item.gist) links.append(link(u, "gist"));
  links.append(link(BOARD_URL, "board"));
  const bodyHeading = kind === "question" ? "Question" : kind ? "Ask" : item.kind === "draft" ? "Draft" : "Description";

  return h(
    "main",
    { class: "item" },
    h("a", { href: "#", class: "back" }, "← Back (u)"),
    h(
      "div",
      { class: "hdr" },
      pill(item.priority),
      h(
        "span",
        { class: "tag" },
        [item.org, kind ?? item.kind, item.state, item.subIssues ? progressText(item.subIssues) : undefined].filter(Boolean).join(" · "),
      ),
    ),
    h("h2", {}, item.title),
    links,
    h("section", {}, h("h3", {}, "Why"), h("div", { class: "md" }, render(item.why || "(empty)"))),
    // A tracker item's own asks, when it is one of their parents too.
    data.action.kind !== "asks" && data.asks?.length ? asksView(data.asks, data.labelOf) : null,
    state ? h("p", { class: "note" }, STATE_NOTE[state]) : null,
    ...actionView(item, data, handlers),
    item.body.trim() ? h("section", {}, h("h3", {}, bodyHeading), h("div", { class: "md" }, render(item.body))) : null,
    h("div", { class: CONTEXT_CLASS }, contextView(item, context, render, data.hooks)),
  );
}
